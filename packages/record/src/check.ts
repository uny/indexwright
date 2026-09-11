/**
 * The `check` verb (SPEC §3, *v0.3 — coverage check*).
 *
 * Every question this verb answers is answered somewhere else. `readiness.ts` decides whether the
 * index set may be reported on, `reconcile.ts` decides whether it is the *candidate* set,
 * `synthesise.ts` decides what a corpus entry replays as, `replay.ts` asks Firestore — the oracle —
 * whether the set covers it, and `baseline.ts` says which gaps this project has already accepted.
 * What is left here is the order they are asked in, the two client lifetimes, and the report.
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
import { canonicalTarget, REQUIRE_IDENTITY, render, type CheckCommand } from './args.js';
import { parseBaseline } from './baseline.js';
import { messageOf } from './client.js';
import { mergeCorpora, parseCorpus } from './corpus.js';
import { isReportable, isTransient, ReadinessGate, DEFAULT_SETTLE_MS, type Readiness } from './readiness.js';
import { isVouched, reconcile, type LiveCompositeIndex, type Reconciliation } from './reconcile.js';
import { planReplay, ReplayError, type ReplayPlan } from './synthesise.js';
import { replayClient, TargetError, type Replayer } from './replay.js';
import type { Corpus, Producer, QueryShape } from './types.js';

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

/** What one corpus yields offline: the entries to replay, the ones that cannot be, and every key. */
interface Planned {
  readonly entries: Entry[];
  readonly unreplayable: string[];
  readonly keys: Set<string>;
}

/**
 * Run the verb, and return the process exit code.
 *
 * - `0` — every entry in the corpus was served by the candidate set, or is named by the baseline.
 * - `1` — at least one was not, and is not named by the baseline. That is the finding, and the
 *   oracle is Firestore rather than a rule this package applies, so unlike `lint` it is worth
 *   failing a pipeline on by default.
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

  // Every part read before any is reported on, so that an unreadable second corpus is found before
  // the first one's identity has been announced — a run that said one part's producer and then
  // declined reads as though the part it named is the one at fault.
  const parts: { readonly path: string; readonly corpus: Corpus; readonly planned: Planned }[] = [];
  for (const path of command.corpus) {
    try {
      const corpus = parseCorpus(readFile(path));
      parts.push({ path, corpus, planned: plan(corpus) });
    } catch (error) {
      say(`could not read the corpus at ${render(path)}: ${detail(error)}`);
      return 2;
    }
  }

  // Said per part rather than over the merge, which is the whole reason the identity is a set on the
  // pair. A merged `producers` naming someone does not mean every part named someone: an anonymous
  // stale part hides behind a named current one, and the merged corpus then presents a wider surface
  // than any of its inputs with nothing in the file recording which is which (issue #56).
  //
  // Said on every run, beside the target, and for the same reason the target is said: it is the
  // other input that cannot be recovered from the output afterwards, and the mistake it guards
  // against — a corpus describing a suite as it was, replayed against a set as it is — is silent by
  // construction. A corpus naming no producer says so out loud rather than printing nothing;
  // silence is the reading this line exists to take away.
  for (const part of parts) {
    say(
      part.corpus.producers.length === 0
        ? `corpus ${render(part.path)} records no producer`
        : `corpus ${render(part.path)} produced by ${part.corpus.producers.map(describeProducer).join(', ')}`,
    );
  }

  // Refused here, before the settling period and before anything is dialled: nothing beyond this
  // point could change the answer, and the fix is on the command line or in the pipeline that wrote
  // the corpus. Exit 2 rather than 1 — this is a run that cannot report, not a run reporting a gap.
  //
  // Per part, for the reason the lines above are per part: the flag asks whether what is being
  // replayed describes the suite as it runs, and a merge is only as answerable as its least
  // identified part.
  if (command.requireIdentity) {
    for (const part of parts) {
      if (part.corpus.producers.length > 0) continue;
      say(
        `cannot report: ${REQUIRE_IDENTITY} was given and the corpus at ${render(part.path)} ` +
          'names no producer, so there is nothing to say whether it describes the suite as it runs today',
      );
      return 2;
    }
  }

  // Refused per part, before the merge rather than after it. `check` refuses a corpus with nothing
  // replayable in it because such a corpus replays cleanly by construction and would exit 0 having
  // measured nothing — and a merge of three corpora one of which is empty loses that signal
  // entirely: the merged file is non-empty, so the run reports full coverage for a set one of whose
  // consuming suites was never captured. That is the failure #56 is about, reached through the merge.
  //
  // Answered here rather than after the gates, because nothing beyond this point could change it:
  // there is no entry to ask the target about, so a settling period would be a minute spent to
  // arrive at the same line.
  //
  // It is also a shape that really occurs: a suite driven through the Firebase Web SDK issues no
  // gRPC at all, so `record` writes a corpus with no queries and counts the requests it could not
  // capture (SPEC §7). The fix for an operator holding one is to drop that part from the command
  // line, which is one argument removed rather than a flag to discover.
  for (const part of parts) {
    if (part.planned.entries.length > 0) continue;
    // This part's own refusals, said before the line that declines: "no entry has a replayable form"
    // on its own asks an operator to go and find out why, and the why is already in hand. Said from
    // the part rather than from the merge because the merge is never reached from here.
    for (const line of part.planned.unreplayable) say(`cannot replay: ${line}`);
    say(
      part.planned.unreplayable.length === 0
        ? `there is nothing to replay: the corpus at ${render(part.path)} holds no queries`
        : `there is nothing to replay: no entry in the corpus at ${render(part.path)} has a replayable form`,
    );
    return 2;
  }

  // Merged after every part has been vouched for individually, so that a refusal names the part it
  // is about. The rules are SPEC §7's own — see `mergeCorpora` — and a mismatched `corpusVersion` or
  // a key two parts disagree on is refused here rather than merged across.
  let entries: readonly Entry[];
  let unreplayable: readonly string[];
  let corpusKeys: ReadonlySet<string>;
  try {
    // Planned again over the merge rather than stitched together out of the per-part plans. The
    // entries a run replays have to be in the merged corpus's own order and de-duplicated on its own
    // key set, and deriving that from one pass over one corpus is how it stays that way; the work is
    // offline and costs microseconds against a settling period measured in minutes.
    const merged = mergeCorpora(parts.map((part) => part.corpus));
    // Said only when there was something to merge. With one corpus the merge is the identity, and a
    // line announcing it would be noise on the overwhelmingly common command line.
    if (parts.length > 1) {
      say(`${parts.length} corpora merged into ${merged.queries.length} ${merged.queries.length === 1 ? 'query' : 'queries'}`);
    }
    ({ entries, unreplayable, keys: corpusKeys } = plan(merged));
  } catch (error) {
    say(`could not merge the corpora: ${detail(error)}`);
    return 2;
  }

  for (const line of unreplayable) say(`cannot replay: ${line}`);

  // Read here rather than where it is used, on the same principle as the two files above: an
  // unreadable baseline is worth finding on the near side of the settling period.
  // Left `undefined` when no baseline was named, rather than collapsed to an empty map: the summary
  // line says how many findings the baseline absorbed, and "none, because there is no baseline" and
  // "none, out of a baseline that named some" are different things for an operator to read.
  let accepted: Map<string, string> | undefined;
  if (command.baseline !== undefined) {
    try {
      accepted = new Map(parseBaseline(readFile(command.baseline)).accepted.map((e) => [e.key, e.reason]));
    } catch (error) {
      say(`could not read the baseline at ${render(command.baseline)}: ${detail(error)}`);
      return 2;
    }
  }

  // Said before anything is dialled, because nothing that follows bears on it. A key the corpus
  // does not hold is accounted for by the corpus alone — no listing, no replay, and no verdict this
  // run might later withdraw can change the answer. It is one of the two ways an entry stops
  // reproducing (the other is being served, which only the target can say), and reporting it is what
  // keeps the file shrinking as gaps close rather than accumulating.
  //
  // Said after the refusal above rather than beside the read, because a corpus with nothing
  // replayable in it has not accounted for anything. A suite driven through the Firebase Web SDK
  // records no queries at all (SPEC §7), and a run that then named every accepted gap as one the
  // corpus no longer holds would be asking an operator to shrink the file on the strength of a run
  // that measured nothing — the same false clean the `served` half is careful not to claim, arriving
  // through the corpus instead of the target.
  for (const [key, reason] of accepted ?? []) {
    if (!corpusKeys.has(key)) {
      say(`in the baseline, but the corpus no longer holds it: ${render(key)} (${render(reason)})`);
    }
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
  // Only the entries the target actually answered `served` for. Deliberately not derived as
  // "everything that is not uncovered": an entry that was unreplayable, came back invalid, or sat
  // after the run halted has no verdict at all, and reporting a baselined gap as no longer
  // reproducing on that evidence would be §2's false clean in miniature — the file shrinks by an
  // entry nobody measured, and the gap comes back as a finding the next time it is reached.
  const served = new Set<string>();
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
      if (status.kind === 'served') {
        served.add(entry.shape.key);
        continue;
      }
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

  // Both gates above read the set once, before the first replayed query. Everything since has been
  // a statement about queries answered *after* that reading, so the run has vouched for a set at one
  // moment and reported about a window that starts there (issue #44). Look once more.
  //
  // Said before the confirmation rather than after it. What the withdrawal takes away is the
  // *verdict*, and these lines are not one: they name the entries this run has no answer for, and
  // they are the likeliest explanation of a confirmation that then also fails — a credential that
  // died mid-run halts the replay and refuses the second listing alike. Withdrawing them too would
  // leave an operator reading `the index set changed` about a run whose real problem was named on a
  // line that was never printed.
  reportUnanswered(invalid, halted, say);

  let held: Reconciliation;
  try {
    held = await confirmSetHeld(target, command.project, candidate, say, {
      lister: options.lister ?? adminLister,
    });
  } catch (error) {
    if (!(error instanceof AdminError)) throw error;
    // A confirmation that could not be made is not a confirmation. Declining here costs a run that
    // was probably fine; not declining reports a verdict nothing stands behind, and §2 ranks those
    // the other way round.
    say(`cannot report: the target could not be listed again after replay: ${error.message}`);
    return 2;
  }
  if (!isVouched(held)) {
    reportDivergence(held, command.indexes, say, withdrawal(held));
    return 2;
  }

  return reportReplay(attempted, uncovered, accepted, served, invalid, cannotReplay, halted, say);
}

/**
 * List once more, after the last query has been answered, and reconcile again.
 *
 * The verb is check-then-act, and this is the only thing that notices when the act happened against
 * something else. A set that moved mid-run fails in both directions: an index removed makes the
 * query that needed it answer `FAILED_PRECONDITION`, which would be reported as a coverage gap the
 * candidate set does not have — the false positive §2 forbids acting on — and an index added has a
 * query served by a declaration the candidate set does not carry, which is the quiet one, and
 * exactly what the `extra` half of `reconcile` exists to catch. Caught before replay, missed during
 * it, until here.
 *
 * What it does not cover is the *state* half of the same window, and the boundary is worth naming
 * rather than leaving to be discovered: `reconcile` compares declarations and does not consult
 * `state` (that is `readiness.ts`'s question), and it keys on fields rather than on the resource
 * name. So an index deleted and re-created under a new name with the same fields, or one that
 * regressed to `CREATING` or `NEEDS_REPAIR` while the queries were being answered, reconciles as
 * `identical` and is vouched for here — and the `FAILED_PRECONDITION` it caused is still reported as
 * a coverage gap. Closing that would mean running the readiness gate a second time, at the cost of a
 * second settling period on every run, which is a trade this change does not make.
 *
 * Whatever this finds can only *withdraw* a verdict. It never turns a `1` into a `0` or the reverse,
 * because it does not look at coverage at all — either the report stands or there is no report.
 *
 * The lister is built again rather than held open across the replay, which keeps #39's invariant
 * that at most one channel is open at a time. A second construction is the price, and it is a small
 * one against a run that has already waited out a settling period.
 */
async function confirmSetHeld(
  target: string,
  project: string,
  candidate: readonly AnalysedIndex[],
  say: (text: string) => void,
  deps: { lister(project: string): Promise<IndexLister> },
): Promise<Reconciliation> {
  const lister = await deps.lister(project);
  try {
    return reconcile(candidate, await listLiveIndexes(target, lister));
  } finally {
    await release('index lister', lister, say);
  }
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
  lead = `cannot report: the target does not hold the candidate index set at ${render(indexesPath)}`,
): void {
  say(lead);
  for (const index of reconciliation.missing) say(`  declared but not on the target: ${render(index.key)}`);
  for (const index of reconciliation.extra) say(`  on the target but not declared: ${render(index.key)}`);
  for (const index of reconciliation.unreadable) {
    say(`  could not be read (${index.reason}): ${render(index.name)} — ${render(index.detail)}`);
  }
  for (const index of reconciliation.incomparable) {
    say(`  declared in terms this version cannot compare (${index.reason}): ${render(index.key)}`);
  }
}

/**
 * Name the entries this run has no answer for, ahead of any verdict about them.
 *
 * Split out of `reportReplay` because it is not part of the report: the report is the coverage
 * verdict, and a withdrawal takes that away without taking away what happened during the replay.
 * These lines say which entry stopped the run and what the target said, and a run that halts on a
 * dead credential is a run whose second listing is about to be refused for the same reason — so the
 * one path that must not eat them is exactly the one that used to.
 */
function reportUnanswered(
  invalid: readonly string[],
  halted: string | undefined,
  say: (text: string) => void,
): void {
  for (const entry of invalid) say(`invalid when replayed, which is not a verdict about the index set: ${entry}`);
  if (halted !== undefined) say(`stopped: the target answered with a status this run cannot read: ${halted}`);
}

/**
 * Say what the confirmation actually established, which is not always that the set changed.
 *
 * `reconcile` refuses a live entry it cannot read — a `fields` the service sent as `null`, an
 * `apiScope` this version cannot compare under — and a declaration left unmatched by one is reported
 * as `missing`. That reads identically to a deleted index and is not the same thing: the set may
 * have held perfectly well and simply been described in terms this run could not compare. Claiming a
 * change on that evidence is the failure this whole confirmation exists to prevent, pointed the
 * other way — an assertion about a window nobody observed.
 *
 * So the softer lead is chosen only where unreadability accounts for the whole disagreement, rather
 * than wherever an unreadable entry appears at all. An entry that could not be read explains at most
 * the one declaration it failed to match, and it cannot explain an `extra` at all — a live entry
 * reported as undeclared was read well enough to be keyed. More `missing` than there are unreadable
 * entries to absorb, or any `extra`, is evidence of a change that survives the doubt, and saying
 * only "could not be compared" over the top of it would understate what the lines beneath it show.
 *
 * `incomparable` is deliberately not consulted: it is derived from the candidate declarations, which
 * are the same array both times, so the first reconciliation would have declined on it long before
 * this is reached.
 */
function withdrawal(held: Reconciliation): string {
  const explained =
    held.unreadable.length > 0 &&
    held.extra.length === 0 &&
    held.missing.length <= held.unreadable.length;
  return explained
    ? 'cannot report: the index set could not be compared again after the queries were answered'
    : 'cannot report: the index set changed while the queries were being answered';
}

/**
 * The report, and the exit code it comes to.
 *
 * The baseline enters here and nowhere else in the arithmetic. A baselined gap is printed with the
 * same `not served` lead as any other, because that is what it is: SPEC §2's rule is about what may
 * be claimed, and "this query is not served, and we have decided to live with it" claims nothing
 * about the index being unnecessary. What the baseline changes is which findings the exit code
 * counts — and the summary line says both numbers, so a run that exits 0 carrying accepted gaps
 * cannot be read as one that found none.
 *
 * The reason is printed on every match rather than only when it is new. An accepted gap that is
 * never re-read is the suppression file the baseline is meant not to be, and the cheapest thing
 * standing against that is the sentence appearing in the log of every run that relies on it.
 */
function reportReplay(
  attempted: number,
  uncovered: readonly { key: string; message: string }[],
  accepted: ReadonlyMap<string, string> | undefined,
  served: ReadonlySet<string>,
  invalid: readonly string[],
  unreplayable: readonly string[],
  halted: string | undefined,
  say: (text: string) => void,
): number {
  let baselined = 0;
  for (const entry of uncovered) {
    const reason = accepted?.get(entry.key);
    say(`not served: ${render(entry.key)}`);
    say(`  ${entry.message}`);
    if (reason !== undefined) {
      baselined += 1;
      say(`  in the baseline, so this does not fail the run: ${render(reason)}`);
    }
  }

  // The second of the two ways a baseline entry stops reproducing, and the one only the target can
  // answer. Said here rather than beside the corpus check because it is part of the report: it is a
  // statement that a query *was* served, which is exactly what a set that moved mid-run would make
  // untrue — so it is withdrawn along with the verdict rather than surviving it.
  //
  // Whether an entry that no longer reproduces should itself fail the run is left open on purpose;
  // issue #57 names it a separate decision, and reporting it is not that decision.
  for (const [key, reason] of accepted ?? []) {
    if (served.has(key)) say(`in the baseline, but served: ${render(key)} (${render(reason)})`);
  }

  const findings = uncovered.length - baselined;
  say(
    `${count(attempted, 'query', 'queries')} replayed, ` +
      `${uncovered.length} not served by the candidate set` +
      (accepted === undefined ? '' : `, ${baselined} of them in the baseline`),
  );
  if (halted !== undefined || invalid.length > 0 || unreplayable.length > 0) {
    // Said out loud rather than left to the exit code. A report that is missing entries is the one
    // an operator is most likely to read as "these and no others".
    say('this report is incomplete: not every entry in the corpus was answered for');
    return 2;
  }
  return findings > 0 ? 1 : 0;
}

/**
 * Plan every entry up front, keeping the ones that cannot be planned.
 *
 * `planReplay` throws for an entry with no replayable form, and SPEC §7 asks that such an entry be
 * reported rather than repaired: every repair available replays a *different* query than the one
 * recorded. So the run continues — the other entries are still worth an answer — and the report says
 * it is incomplete.
 */
function plan(corpus: Corpus): Planned {
  const entries: Entry[] = [];
  const unreplayable: string[] = [];
  // Every key the corpus named, planned or not. A baseline entry is only known not to reproduce if
  // the run can account for it, and "the corpus no longer holds this query" is one of the two ways
  // it can — so the set has to include the entries that got no further than planning.
  const keys = new Set<string>();
  for (const shape of corpus.queries) {
    keys.add(shape.key);
    try {
      entries.push({ shape, plan: planReplay(shape) });
    } catch (error) {
      if (!(error instanceof ReplayError)) throw error;
      unreplayable.push(`${render(shape.key)}: ${error.message}`);
    }
  }
  return { entries, unreplayable, keys };
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

/**
 * One producer as a line an operator reads, rendered.
 *
 * Rendered for the same reason `detail` is: a corpus is a committed artefact this machine did not
 * necessarily author, and this text goes onto the stream the target is announced on. The recorder
 * refuses a control character where it enters, but a corpus can arrive by any route.
 */
function describeProducer(producer: Producer): string {
  return producer.revision === null
    ? `${render(producer.name)} at an unnamed revision`
    : `${render(producer.name)} at ${render(producer.revision)}`;
}

function names(list: readonly string[]): string {
  return list.map(render).join(', ');
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
