/**
 * The `check` verb (SPEC §3, *v0.3 — coverage check*).
 *
 * Every question this verb answers is answered somewhere else. `readiness.ts` decides whether the
 * index set may be reported on, `reconcile.ts` decides whether it is the *candidate* set,
 * `synthesise.ts` decides what a corpus entry replays as, and `replay.ts` asks Firestore — the
 * oracle — whether the set covers it. What is left here is the order they are asked in, the two
 * client lifetimes, and the report.
 *
 * The order is a gate rather than a sequence, and the gating is the point. A report that goes out
 * before readiness is established, or before the observed set is known to be the candidate set, is
 * not a weaker answer than a correct one — it is a confident answer about something nobody asked
 * about. So each stage either passes the next one a listing it has vouched for, or the run declines
 * and says which question it could not settle.
 *
 * Nothing is applied and nothing is written. `check` is a read.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyse, parseDocument, type AnalysedIndex } from 'indexwright';
import { adminLister, AdminError, listLiveIndexes, type IndexLister } from './admin.js';
import { canonicalTarget, render, type CheckCommand } from './args.js';
import { messageOf } from './client.js';
import { parseCorpus } from './corpus.js';
import { isReportable, isTransient, ReadinessGate, DEFAULT_SETTLE_MS, type Readiness } from './readiness.js';
import { isVouched, reconcile, type LiveCompositeIndex, type Reconciliation } from './reconcile.js';
import { planReplay, ReplayError, type ReplayPlan } from './synthesise.js';
import { replayClient, TargetError, type Replayer } from './replay.js';
import type { QueryShape } from './types.js';

export interface Streams {
  out(text: string): void;
  err(text: string): void;
}

/** How often the readiness poll asks again while an index is still building. */
export const DEFAULT_POLL_MS = 5_000;

/**
 * How long the readiness poll will wait before giving up.
 *
 * An unbounded poll is the wrong default for a command a CI job runs: an index that never finishes
 * building leaves the job occupying a runner rather than reporting a problem. The bound is generous
 * because a real build on a populated collection is measured in minutes, and hitting it is reported
 * as "readiness could not be established" — which is what it is — rather than as a verdict.
 */
export const DEFAULT_DEADLINE_MS = 15 * 60_000;

/**
 * The seams a test needs, and nothing else.
 *
 * The clock and the sleep are here because the settling period is a minute by design: a test that
 * had to wait it out could not pin the gate's behaviour at all. The two client factories are here
 * for the same reason — the shipped path passes the real ones, which carry the redirect refusal in
 * the module that builds the client, so substituting them is a test's business and not a route
 * around the guard.
 */
export interface CheckOptions {
  lister?(project: string): Promise<IndexLister>;
  replayer?(project: string, database: string): Promise<Replayer>;
  readFile?(path: string): string;
  /** Must be monotonic. See `ReadinessGate.observe`. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  settleMs?: number;
  pollMs?: number;
  deadlineMs?: number;
}

interface Entry {
  readonly shape: QueryShape;
  readonly plan: ReplayPlan;
}

/**
 * Run the verb, and return the process exit code.
 *
 * - `0` — every entry in the corpus was served by the candidate set.
 * - `1` — at least one was not. That is the finding, and the oracle is Firestore rather than a rule
 *   this package applies, so unlike `lint` it is worth failing a pipeline on by default.
 * - `2` — the run could not answer: a file it could not read, a readiness it could not establish, a
 *   set that is not the candidate set, an entry it could not replay, a status it cannot interpret.
 *   It takes precedence over `1`, because a report that is missing entries is not a clean report
 *   with a caveat — an operator who sees `1` should be able to read it as "these and no others".
 *
 * The target line is written by the caller before this is reached (see `cli.ts`), so that it is on
 * the stream before anything at all happens.
 */
export async function check(
  command: CheckCommand,
  streams: Streams,
  options: CheckOptions = {},
): Promise<number> {
  const say = (text: string): void => streams.err(`indexwright-record: ${text}\n`);
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readFile = options.readFile ?? defaultReadFile;
  const target = canonicalTarget(command);

  // Read and plan before anything is constructed, let alone dialled. Everything up to the first
  // client is offline and costs milliseconds, and everything after it costs a minute of settling at
  // the least — so a mistyped path or an unreplayable corpus should be found on the near side of
  // that wait rather than the far side.
  let candidate: AnalysedIndex[];
  try {
    candidate = analyse(parseDocument(readFile(command.indexes)));
  } catch (error) {
    say(`could not read the candidate indexes at ${render(command.indexes)}: ${detail(error)}`);
    return 2;
  }

  let entries: readonly Entry[];
  let unreplayable: readonly string[];
  try {
    ({ entries, unreplayable } = plan(readFile(command.corpus)));
  } catch (error) {
    say(`could not read the corpus at ${render(command.corpus)}: ${detail(error)}`);
    return 2;
  }
  for (const line of unreplayable) say(`cannot replay: ${line}`);

  if (entries.length === 0) {
    // Answered here rather than after the gates, because nothing beyond this point could change it:
    // there is no entry to ask the target about, so a settling period would be a minute spent to
    // arrive at the same line.
    //
    // An empty corpus is refused rather than reported as full coverage. It replays cleanly by
    // construction, so the run would exit 0 having measured nothing — the false clean verdict §2
    // forbids most strictly, arriving at the one moment nothing looks wrong. It is also a shape that
    // really occurs: a suite driven through the Firebase Web SDK issues no gRPC at all, so `record`
    // writes a corpus with no queries and counts the requests it could not capture (SPEC §7).
    say(
      unreplayable.length === 0
        ? `there is nothing to replay: the corpus at ${render(command.corpus)} holds no queries`
        : `there is nothing to replay: no entry in the corpus at ${render(command.corpus)} has a replayable form`,
    );
    return 2;
  }

  let live: readonly LiveCompositeIndex[];
  try {
    live = await establishReadiness(target, command.project, say, {
      lister: options.lister ?? adminLister,
      now,
      sleep,
      settleMs,
      pollMs,
      deadlineMs,
    });
  } catch (error) {
    if (error instanceof AdminError || error instanceof Declined) {
      say(`readiness could not be established: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const reconciliation = reconcile(candidate, live);
  if (!isVouched(reconciliation)) {
    reportDivergence(reconciliation, command.indexes, say);
    return 2;
  }
  say(
    `${count(live.length, 'index', 'indexes')} on the target, and the candidate set at ` +
      `${render(command.indexes)} is the set that is there`,
  );

  let replayer: Replayer;
  try {
    replayer = await (options.replayer ?? replayClient)(command.project, command.database);
  } catch (error) {
    if (!(error instanceof TargetError)) throw error;
    say(`could not reach the replay target: ${error.message}`);
    return 2;
  }

  const uncovered: { key: string; message: string }[] = [];
  const invalid: string[] = [];
  // Seeded with what planning refused, and added to by anything materialisation refuses that
  // planning did not. Both mean the same thing to the report: an entry with no verdict.
  const cannotReplay: string[] = [...unreplayable];
  let attempted = 0;
  let halted: string | undefined;
  try {
    for (const entry of entries) {
      // One at a time. The order of the report is then the order of the corpus rather than of
      // whichever request happened to come back first, and a throwaway database is not the place to
      // find out how a burst of concurrent queries is throttled.
      const status = await replayer.run(entry.plan);
      // Counted once the target has answered, so an entry that never reached it is not reported as
      // a query that was replayed.
      if (status.kind !== 'unbuildable') attempted += 1;
      if (status.kind === 'served') continue;
      if (status.kind === 'uncovered') uncovered.push({ key: entry.shape.key, message: status.message });
      else if (status.kind === 'invalid') invalid.push(`${render(entry.shape.key)}: ${status.message}`);
      else if (status.kind === 'unbuildable') {
        // The same bucket a plan-time refusal lands in, because it is the same answer: this run has
        // no verdict for this entry. `planReplay` is supposed to have caught it already, so arriving
        // here means the two disagree — said out loud, counted as incomplete, and not carried on
        // with as though the corpus had been covered.
        cannotReplay.push(`${render(entry.shape.key)}: ${status.message}`);
        say(`cannot replay: ${render(entry.shape.key)}: ${status.message}`);
      } else {
        // Stopped rather than carried on with. A status this verb cannot interpret is almost never
        // about the one entry that met it — a missing permission, a database that is not there, a
        // connection that is gone — so the remaining entries would meet the same wall and the report
        // would be a page of identical failures with a coverage verdict hidden in it.
        halted = `${render(entry.shape.key)}: ${status.message}`;
        break;
      }
    }
  } finally {
    // A live gRPC channel refs the event loop, so this is what makes the process exit after the
    // report rather than sit there having printed it (issue #39).
    await release('replay client', replayer, say);
  }

  return reportReplay(attempted, uncovered, invalid, cannotReplay, halted, say);
}

/** A verdict the gate reached that waiting cannot change, carried out of the poll as a message. */
class Declined extends Error {}

interface ReadinessDeps {
  lister(project: string): Promise<IndexLister>;
  now(): number;
  sleep(ms: number): Promise<void>;
  settleMs: number;
  pollMs: number;
  deadlineMs: number;
}

/**
 * Poll until the set is reportable, and hand back the listing it was reportable on.
 *
 * The listing returned is the *last* one observed rather than the first, and that matters: it is the
 * one `reconcile` is then run against, so the set that was vouched for as ready and the set that is
 * compared to the candidate file are the same observation. Two listings could differ, and reconciling
 * against the earlier one would vouch for a set that is no longer there.
 *
 * The lister is closed here, on every path out, and before the replay client is built. At most one
 * channel is therefore open at a time.
 */
async function establishReadiness(
  target: string,
  project: string,
  say: (text: string) => void,
  deps: ReadinessDeps,
): Promise<readonly LiveCompositeIndex[]> {
  // Constructed before the client, not after: `ReadinessGate` rejects a `settleMs` it cannot use,
  // and a throw between building the lister and entering the `try` below is one nothing would close.
  const gate = new ReadinessGate(deps.settleMs);
  const lister = await deps.lister(project);
  const started = deps.now();
  // Said when it changes rather than on every poll. A fifteen-minute deadline at five seconds a poll
  // is a hundred and eighty identical lines, and a progress line that repeats is one a reader stops
  // reading — including the line that says *which* index is still building, which is the only part
  // of it worth anything.
  let last: string | undefined;
  try {
    for (;;) {
      const live = await listLiveIndexes(target, lister);
      const verdict = gate.observe(live, deps.now());
      if (isReportable(verdict)) return live;
      if (!isTransient(verdict)) throw new Declined(describe(verdict));
      const waited = deps.now() - started;
      if (waited >= deps.deadlineMs) {
        throw new Declined(
          `${describe(verdict)}, and this run has waited ${Math.round(waited / 1000)}s`,
        );
      }
      if (verdict.kind === 'building') {
        const line = describe(verdict);
        if (line !== last) say(`waiting: ${line}`);
        last = line;
      }
      // Clamped to what is left of the deadline. A settling period is up to a minute, and sleeping
      // it whole from 14 minutes in returned *past* the bound this run advertises — benign, since
      // the set really was settling, but a bound that is only approximately kept is one a reader
      // cannot use. The loop re-observes either way; a short sleep costs one extra listing.
      const remaining = deps.deadlineMs - waited;
      const wanted = verdict.kind === 'settling' ? verdict.remainingMs : deps.pollMs;
      await deps.sleep(Math.max(0, Math.min(wanted, remaining)));
    }
  } finally {
    await release('index lister', lister, say);
  }
}

/**
 * Let go of a client without letting the release replace the outcome.
 *
 * A `finally` that throws discards whatever the block was carrying — the decline being raised, or
 * the report about to be printed — and leaves a rejection naming nothing anyone asked about. That is
 * the shape issue #41 fixed twice over on the decline path, and closing a client is the other place
 * this verb has one. Reported rather than swallowed: a channel that would not close is worth a line,
 * not least because it is the likeliest explanation for a run that then does not exit.
 */
async function release(
  what: string,
  client: { close(): Promise<void> },
  say: (text: string) => void,
): Promise<void> {
  try {
    await client.close();
  } catch (error) {
    say(`could not release the ${what}: ${detail(error)}`);
  }
}

function describe(verdict: Readiness): string {
  switch (verdict.kind) {
    case 'ready':
      return 'every index is ready';
    case 'settling':
      return `every index is ready, and the set has ${Math.round(verdict.remainingMs / 1000)}s of its settling period left`;
    case 'building':
      return `${count(verdict.indexes.length, 'index', 'indexes')} still building: ${names(verdict.indexes)}`;
    case 'damaged':
      return `${count(verdict.indexes.length, 'index', 'indexes')} in NEEDS_REPAIR, which waiting does not resolve: ${names(verdict.indexes)}`;
    case 'unrecognised':
      return (
        `${count(verdict.indexes.length, 'index', 'indexes')} in a state this version cannot ` +
        `classify (${verdict.states.map(render).join(', ')}): ${names(verdict.indexes)}`
      );
  }
}

/**
 * Say which way the two sets disagree, in the terms the reader can act in.
 *
 * `missing` and `extra` are named separately rather than counted together because the fixes are
 * opposite ones — deploy the candidate set, or start from a database that does not carry more than
 * it — and because only one of them is the quiet failure: a target holding an *extra* index serves
 * queries the candidate set alone would not, so the run that was about to happen would have come
 * back clean.
 */
function reportDivergence(
  reconciliation: Reconciliation,
  indexesPath: string,
  say: (text: string) => void,
): void {
  say(`cannot report: the target does not hold the candidate index set at ${render(indexesPath)}`);
  for (const index of reconciliation.missing) say(`  declared but not on the target: ${render(index.key)}`);
  for (const index of reconciliation.extra) say(`  on the target but not declared: ${render(index.key)}`);
  for (const index of reconciliation.unreadable) {
    say(`  could not be read (${index.reason}): ${render(index.name)} — ${render(index.detail)}`);
  }
  for (const index of reconciliation.incomparable) {
    say(`  declared in terms this version cannot compare (${index.reason}): ${render(index.key)}`);
  }
}

function reportReplay(
  attempted: number,
  uncovered: readonly { key: string; message: string }[],
  invalid: readonly string[],
  unreplayable: readonly string[],
  halted: string | undefined,
  say: (text: string) => void,
): number {
  for (const entry of uncovered) {
    say(`not served: ${render(entry.key)}`);
    say(`  ${entry.message}`);
  }
  for (const entry of invalid) say(`invalid when replayed, which is not a verdict about the index set: ${entry}`);
  if (halted !== undefined) say(`stopped: the target answered with a status this run cannot read: ${halted}`);

  say(
    `${count(attempted, 'query', 'queries')} replayed, ` +
      `${uncovered.length} not served by the candidate set`,
  );
  if (halted !== undefined || invalid.length > 0 || unreplayable.length > 0) {
    // Said out loud rather than left to the exit code. A report that is missing entries is the one
    // an operator is most likely to read as "these and no others".
    say('this report is incomplete: not every entry in the corpus was answered for');
    return 2;
  }
  return uncovered.length > 0 ? 1 : 0;
}

/**
 * Plan every entry up front, keeping the ones that cannot be planned.
 *
 * `planReplay` throws for an entry with no replayable form, and SPEC §7 asks that such an entry be
 * reported rather than repaired: every repair available replays a *different* query than the one
 * recorded. So the run continues — the other entries are still worth an answer — and the report says
 * it is incomplete.
 */
function plan(source: string): { entries: Entry[]; unreplayable: string[] } {
  const corpus = parseCorpus(source);
  const entries: Entry[] = [];
  const unreplayable: string[] = [];
  for (const shape of corpus.queries) {
    try {
      entries.push({ shape, plan: planReplay(shape) });
    } catch (error) {
      if (!(error instanceof ReplayError)) throw error;
      unreplayable.push(`${render(shape.key)}: ${error.message}`);
    }
  }
  return { entries, unreplayable };
}

function defaultReadFile(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

/**
 * A failure that came from reading a file, as one line.
 *
 * Rendered rather than interpolated. A corpus and a candidate index file are committed artefacts
 * this machine did not necessarily author, and both parsers quote the offending source when they
 * refuse it — so an unrendered message is a route from a file's contents onto the stream the target
 * is announced on.
 */
function detail(error: unknown): string {
  return render(messageOf(error));
}

function names(list: readonly string[]): string {
  return list.map(render).join(', ');
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
