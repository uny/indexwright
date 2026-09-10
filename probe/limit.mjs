/**
 * The instrument for issue #43's open question: whether `limit(1)` changes which index serves a
 * query.
 *
 * `replay.ts` sends no `limit`, and the argument for that is explicit about being unmeasured: *if*
 * a limit narrowed index selection, the cost would be a query served that should have failed — a
 * false clean verdict, which SPEC §2 forbids more strictly than a false alarm. That "if" is what
 * this run is for. The alternative fix the issue proposed — `stream()`, destroyed after the first
 * document — is not available: destroying the stream `stream()` returns only unpipes it, the RPC
 * behind it is never cancelled, and the client lifetime that `terminate()` waits on never settles.
 * So the question the issue deferred is now the question the fix turns on.
 *
 * **The falsification condition, stated exactly:** for one shape, the bare query and the same query
 * with `limit(1)` both reach the backend and disagree on served versus `FAILED_PRECONDITION`. One
 * disagreement is enough, and it means `limit(1)` is not available as a fix at any cost.
 *
 * The rule that decides that lives in `summarise.mjs`, unchanged and shared with
 * `differential.mjs`: two comparable verdicts for one shape that differ is a falsified claim there
 * too. Only the axis is different — the operand is held at the sentinel `replay.ts` actually sends,
 * and what varies is the limit.
 *
 * **This is a separate instrument rather than two more variants in `differential.mjs`, and the
 * reason is what a variant count means.** That script reports the number of operands a shape was
 * compared over, and an operator reads it as the strength of the evidence for §7's claim. A limit
 * is not an operand. Adding it there would inflate that count with a row that says nothing about
 * §7 — the same objection that kept `ref-sentinel` out of the variant list.
 *
 * **The document counts are half the point.** Issue #43 is about what a replay costs, not about
 * whether it is correct, so every row reports how many documents came back. The `!=` shape is the
 * one the issue names, and the run before this one measured it at 429 of a 500-document
 * collection; if `limit(1)` is selection-neutral, the same shape reads 1.
 *
 * Nothing here imports `replay.ts`'s classifier, for the reason `differential.mjs` does not: this
 * is meant to be a second opinion about what the database said.
 *
 * Usage: node probe/limit.mjs <project> [database]
 *          [--expect-uncovered <ids>] [--expect-served <ids>]
 *
 * The `--expect-` flags mean what they mean in `differential.mjs`: the verdict the runbook predicts
 * for a shape, so that a shape answering against its prediction exits non-zero rather than printing
 * a line somebody has to notice. Run this against the *deployed* index set, not a bare target: a
 * target where everything fails carries no information about selection.
 */

import { Firestore } from '@google-cloud/firestore';
import { COLLECTION, SENTINEL, SHAPES } from './shapes.mjs';
import { UsageError, parseExpectations } from './expectations.mjs';
import { readProblems, summarise, summaryLines } from './summarise.mjs';

// The guard `check` applies, for the reason `check` applies it. An emulator enforces no composite
// indexes at all, so every shape would answer served whatever the limit did.
for (const name of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN']) {
  if (process.env[name] !== undefined && process.env[name] !== '') {
    process.stderr.write(`probe-limit: refusing to run while ${name} is set\n`);
    process.exit(2);
  }
}

let expected;
let project;
let database;
try {
  const parsed = parseExpectations(process.argv.slice(2), SHAPES.map((shape) => shape.id));
  expected = parsed.expected;
  [project, database = '(default)'] = parsed.positional;
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`probe-limit: ${error.message}\n`);
  process.stderr.write(
    'probe-limit: usage: node probe/limit.mjs <project> [database] ' +
      '[--expect-uncovered <ids>] [--expect-served <ids>]\n',
  );
  process.exit(2);
}

const db = new Firestore({ projectId: project, databaseId: database });
const collection = db.collection(COLLECTION);

const FAILED_PRECONDITION = 9;
const INVALID_ARGUMENT = 3;

/** What the database answered, reduced to the three answers this question has. */
async function ask(query) {
  try {
    const snapshot = await query.get();
    return { verdict: 'served', read: snapshot.size };
  } catch (error) {
    const code = typeof error?.code === 'number' ? error.code : undefined;
    if (code === FAILED_PRECONDITION) return { verdict: 'uncovered', message: error.message };
    if (code === INVALID_ARGUMENT) return { verdict: 'invalid', message: error.message };
    return { verdict: 'other', code, message: error?.message ?? String(error) };
  }
}

/**
 * The two issuings, in the order they are compared.
 *
 * `no-limit` is exactly what `replay.ts` sends today, so `limit-1` is read as "what changes when a
 * limit is added" rather than the other way round.
 */
const ISSUINGS = [
  { name: 'no-limit', apply: (query) => query },
  { name: 'limit-1', apply: (query) => query.limit(1) },
];

/** The two names, read from the table rather than respelled, so the report cannot drift from it. */
const [BARE, LIMITED] = ISSUINGS.map((issuing) => issuing.name);

/** Every slot filled from the sentinel, which is the one operand `replay.ts` ever sends. */
const values = {
  scalar: () => SENTINEL,
  list: () => [SENTINEL],
  ref: () => collection.doc(SENTINEL),
};

const results = [];
for (const shape of SHAPES) {
  for (const issuing of ISSUINGS) {
    let outcome;
    try {
      outcome = await ask(issuing.apply(shape.build(collection, values)));
    } catch (error) {
      // Thrown while *building* rather than while running: not an answer, and not a statement about
      // the index set. The same kind `differential.mjs` records it as.
      outcome = { verdict: 'unbuildable', message: error?.message ?? String(error) };
    }
    results.push({ shape: shape.id, variant: issuing.name, ...outcome });
    process.stderr.write(
      `probe-limit: ${shape.id} ${issuing.name.padEnd(9)} ${outcome.verdict}` +
        (outcome.read === undefined ? '' : ` (${outcome.read} documents read)`) +
        '\n',
    );
  }
}

const { findings, unreliable, unexpected, exitCode } = summarise(results, SHAPES, expected);

process.stderr.write('\n');
for (const line of summaryLines({
  findings,
  unreliable,
  unexpected,
  // Not `differential.mjs`'s two words. This run holds the operand at the sentinel and varies
  // the limit, so `FALSIFIES SPEC §7 … (2 of 2 operands)` would name a claim it never tested and
  // count a limit as an operand — the very thing this file's header argues it is not.
  claim: 'the limit-neutrality claim (issue #43)',
  unit: 'issuings',
})) {
  process.stderr.write(`probe-limit: ${line}\n`);
}

// The other half of what this run is for, and an independent observation from the verdict: the
// verdict says whether the fix is *allowed*, this says whether it is worth making. It carries its own
// stop rule because the one the runbook used to carry could not fail — `read` is `snapshot.size` and
// the limited issuing is `.limit(1)`, so "a limit-1 row reporting more than 1" is unreachable by
// construction. `readProblems` is the reachable replacement; it lives in `summarise.mjs` so that a
// gate this run exits 2 on is executed by a test rather than asserted here.
process.stderr.write('\n');
const { problems } = readProblems(results, SHAPES, BARE, LIMITED);
for (const shape of SHAPES) {
  const bare = results.find((r) => r.shape === shape.id && r.variant === BARE);
  const limited = results.find((r) => r.shape === shape.id && r.variant === LIMITED);
  if (bare?.read === undefined || limited?.read === undefined) continue;
  process.stderr.write(
    `probe-limit: ${shape.id} read ${bare.read} documents bare and ${limited.read} with limit(1)\n`,
  );
}
for (const problem of problems) process.stderr.write(`probe-limit: READ HALF UNMEASURED — ${problem}\n`);

process.stdout.write(
  `${JSON.stringify({ project, database, expected: Object.fromEntries(expected), results, findings, unreliable, unexpected, readProblems: problems }, null, 2)}\n`,
);
// Set before the teardown, for the reason `differential.mjs` sets it before its own: `terminate()`
// can reject on a network drop after the last query, and a rejected top-level await in an entry
// module exits 1 without reaching anything after it — discarding the stop rule by way of the event
// most likely to accompany the failures it exits 2 on.
// 2 rather than 1, and it outranks a falsification, for the reason `summarise.mjs` gives: 2 is
// "could not answer", and a run whose read half measured nothing has not answered the second of the
// two questions step 5b exists to ask.
process.exitCode = problems.length > 0 ? 2 : exitCode;
try {
  await db.terminate();
} catch (error) {
  process.stderr.write(`probe-limit: closing the client failed: ${error?.message ?? String(error)}\n`);
  process.stdout.write('', () => process.exit(process.exitCode));
}
