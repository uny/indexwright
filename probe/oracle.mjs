/**
 * The instrument for issue #91's open question: whether `Query.explain({ analyze: false })`
 * disagrees with `Query.get()` about which of S1–S20 the candidate set serves.
 *
 * `replay.ts`'s `askOracle` sends the identical `limit(1)` query to whichever oracle `check` was
 * given, on the argument that a query neither oracle's own materialisation can tell apart is a query
 * a disagreement between the two can only be about the oracle, never about what was asked (see
 * `buildReplayQuery`'s docblock). This script is that argument's falsification instrument, over the
 * same twenty shapes `limit.mjs` (issue #43) and `differential.mjs` (SPEC §7) already exercise —
 * S1–S8 the base set, S9–S12 disjunctions and collection groups (issue #69), S13–S20 the remaining
 * operators (issue #89).
 *
 * **The falsification condition, stated exactly:** for one shape, `read` and `explain` both reach
 * the backend and disagree on `served` versus `FAILED_PRECONDITION`. One disagreement is enough,
 * and it means the two oracles are not interchangeable the way `buildReplayQuery`'s docblock and
 * SPEC §3 claim.
 *
 * **What this script does not, and must not, measure.** Query Explain's documented behaviour —
 * "no index or read operations are performed" under `analyze: false`, one read charged regardless —
 * is read from Google's own documentation, not from this run: nothing here inspects
 * `ExplainMetrics` or `planSummary.indexesUsed` to confirm it, for the same reason `askOracle` never
 * does in the shipped path (SPEC §3). And the *settling-window* half of the adopter's claim in issue
 * #91 — that `explain` answers `FAILED_PRECONDITION` the same way while an index is still
 * `CREATING`, not only once it is `READY` — needs a fresh index build to catch that window, which
 * this step does not perform; it runs against whichever set step 4's watcher already settled. A run
 * of this script is evidence for the *identical-query, identical-verdict* claim only, over the set
 * as it stands when the script is run.
 *
 * Nothing here imports `replay.ts`'s classifier, for the reason `differential.mjs` and `limit.mjs`
 * do not: this is meant to be a second opinion about what the database said, not a test of the
 * classifier reading its own answer back.
 *
 * Usage: node probe/oracle.mjs <project> [database]
 *          [--expect-uncovered <ids>] [--expect-served <ids>]
 *
 * The `--expect-` flags mean what they mean in `limit.mjs` and `differential.mjs`: the verdict the
 * runbook predicts for a shape under the *deployed* set, so a shape answering against its prediction
 * exits non-zero rather than printing a line somebody has to notice.
 */

import { Firestore } from '@google-cloud/firestore';
import { COLLECTION, SENTINEL, SHAPES } from './shapes.mjs';
import { UsageError, parseExpectations } from './expectations.mjs';
import { summarise, summaryLines } from './summarise.mjs';

// The guard `check` applies, for the reason `check` applies it. An emulator enforces no composite
// indexes at all, so every shape would answer served through either oracle, telling this run nothing
// about whether the two agree.
for (const name of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN']) {
  if (process.env[name] !== undefined && process.env[name] !== '') {
    process.stderr.write(`probe-oracle: refusing to run while ${name} is set\n`);
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
  process.stderr.write(`probe-oracle: ${error.message}\n`);
  process.stderr.write(
    'probe-oracle: usage: node probe/oracle.mjs <project> [database] ' +
      '[--expect-uncovered <ids>] [--expect-served <ids>]\n',
  );
  process.exit(2);
}

const db = new Firestore({ projectId: project, databaseId: database });
const collection = db.collection(COLLECTION);

const FAILED_PRECONDITION = 9;
const INVALID_ARGUMENT = 3;

/**
 * The two oracles, in the order they are compared. `read` first, since it is the default
 * `askOracle` falls back to and the reading every version before #91 took.
 *
 * Neither closure reads what its call resolved with — `get()`'s `QuerySnapshot` no more than
 * `explain()`'s `ExplainResults` — because the question this script asks is answered entirely by
 * whether the call *threw*, which is `askOracle`'s own discipline and the reason to keep it here
 * too: a probe that read the payload to double-check itself would not be measuring what the shipped
 * code measures.
 */
const ORACLES = [
  { name: 'read', ask: (query) => query.get() },
  { name: 'explain', ask: (query) => query.explain({ analyze: false }) },
];

/** Every slot filled from the sentinel, which is the one operand `replay.ts` ever sends. */
const values = {
  scalar: () => SENTINEL,
  list: () => [SENTINEL],
  ref: () => collection.doc(SENTINEL),
};

const results = [];
for (const shape of SHAPES) {
  for (const oracle of ORACLES) {
    let outcome;
    let query;
    try {
      // `limit(1)` unconditionally, on both oracles alike: `buildReplayQuery` sends it whichever
      // oracle `check` was given (see its docblock), so a probe that varied it between `read` and
      // `explain` would be measuring a different disagreement than the shipped code could ever have.
      query = shape.build(collection, values).limit(1);
    } catch (error) {
      // Thrown while *building* rather than while asking: not an answer, and not a statement about
      // the index set. The same kind `differential.mjs` and `limit.mjs` record it as.
      outcome = { verdict: 'unbuildable', message: error?.message ?? String(error) };
    }
    if (outcome === undefined) {
      try {
        await oracle.ask(query);
        outcome = { verdict: 'served' };
      } catch (error) {
        const code = typeof error?.code === 'number' ? error.code : undefined;
        if (code === FAILED_PRECONDITION) outcome = { verdict: 'uncovered', message: error.message };
        else if (code === INVALID_ARGUMENT) outcome = { verdict: 'invalid', message: error.message };
        else outcome = { verdict: 'other', code, message: error?.message ?? String(error) };
      }
    }
    results.push({ shape: shape.id, variant: oracle.name, ...outcome });
    process.stderr.write(`probe-oracle: ${shape.id} ${oracle.name.padEnd(7)} ${outcome.verdict}\n`);
  }
}

const { findings, unreliable, unexpected, exitCode } = summarise(results, SHAPES, expected);

process.stderr.write('\n');
for (const line of summaryLines({
  findings,
  unreliable,
  unexpected,
  // Not `limit.mjs`'s words, and not SPEC §7's either: this run holds the query fixed — the same
  // query on both sides — and varies only which oracle asked it, so what a disagreement falsifies
  // is the identical-query, identical-verdict claim issue #91 makes, and nothing broader.
  claim: 'the explain-oracle claim (issue #91)',
  unit: 'oracles',
})) {
  process.stderr.write(`probe-oracle: ${line}\n`);
}

process.stdout.write(
  `${JSON.stringify({ project, database, expected: Object.fromEntries(expected), results, findings, unreliable, unexpected }, null, 2)}\n`,
);
// Set before the teardown, for the reason `limit.mjs` and `differential.mjs` set it before their
// own: `terminate()` can reject on a network drop after the last query, and a rejected top-level
// await in an entry module exits 1 without reaching anything after it — discarding the exit code
// this run actually reached in favour of one that says nothing about the claim.
process.exitCode = exitCode;
try {
  await db.terminate();
} catch (error) {
  process.stderr.write(`probe-oracle: closing the client failed: ${error?.message ?? String(error)}\n`);
  process.stdout.write('', () => process.exit(process.exitCode));
}
