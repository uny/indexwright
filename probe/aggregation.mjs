/**
 * The instrument for issue #93's open questions about aggregation replay: whether `count()`,
 * `sum(field)`, and `average(field)` are served or uncovered the way the same inner query is as a
 * plain read, and whether the two oracles (`read`/`explain`, issue #91) agree about an aggregation
 * the way they were measured to agree about a plain query in `oracle.mjs`.
 *
 * **Why this needs its own shapes rather than reusing `shapes.mjs`'s `SHAPES`.** Those build a
 * `Query`; an aggregation replays as an `AggregateQuery`, built from a `Query` but not one itself —
 * `buildReplayAggregateQuery` never calls `.limit()`, and there is nowhere on `.count()`/
 * `.aggregate()` to call it even if it wanted to (see `synthesise.ts`'s `AggregationReplayPlan`
 * docblock for why that is not a gap: the plain path's `limit(1)` was measured against reads, never
 * against an aggregate). So the two field pairs below are deliberately the same ones `S1`
 * (`a == / b >`, declared, covered) and `S6` (`a == / n >`, undeclared, uncovered) already use —
 * this instrument asks the identical question about the identical index gap, just of a
 * `count()`/`sum()`/`average()` instead of a `get()`.
 *
 * **The falsification conditions, stated exactly, and separately:**
 *   1. *Selection.* An aggregation over the covered pair is `served` and over the uncovered pair is
 *      `uncovered` — the same as the plain shape's own verdict. A mismatch would mean an
 *      aggregation's index requirement is not simply the inner query's, which SPEC §7's *Aggregation
 *      queries* section takes as read from Firestore's own documentation rather than as measured.
 *   2. *Oracle agreement.* `read` and `explain` agree on served versus `FAILED_PRECONDITION` for
 *      every shape here, the same claim `oracle.mjs` falsifies for plain queries. `askOracle` does
 *      not know it is asking an `AggregateQuery` rather than a `Query` — `Askable` is structural —
 *      so a disagreement reachable only through this RPC is exactly what that genericity could get
 *      wrong.
 *
 * **What this script does not measure**, and why it is still worth running: `--oracle read`'s
 * *cost* — whether `count()` over the wide `!=`-style shape actually scans the matching range the
 * way SPEC §7 assumes without having measured it. That would need a document-count or a billing
 * signal `AggregateQuerySnapshot` does not expose the way `QuerySnapshot.size` does for `limit.mjs`,
 * and is left as a documented gap in the guidance to prefer `--oracle explain` for an aggregation
 * corpus, not as a claim this script backs.
 *
 * Usage: node probe/aggregation.mjs <project> [database]
 *          [--expect-uncovered <ids>] [--expect-served <ids>]
 *
 * The `--expect-` flags mean what they mean in `oracle.mjs` and `limit.mjs`: the verdict the runbook
 * predicts for a shape under the *deployed* set, so a shape answering against its prediction exits
 * non-zero rather than printing a line somebody has to notice. Run against the deployed candidate
 * set (step 4 or step 5c's watcher), not a bare target.
 */

import { AggregateField, Firestore } from '@google-cloud/firestore';
import { COLLECTION } from './shapes.mjs';
import { UsageError, parseExpectations } from './expectations.mjs';
import { summarise, summaryLines } from './summarise.mjs';

/**
 * Six shapes: the three aggregation functions, each over the covered and the uncovered field pair
 * `S1`/`S6` already establish. `covered` is the prediction `--expect-served`/`--expect-uncovered`
 * check against, exactly as it is in `shapes.mjs`.
 */
const SHAPES = [
  { id: 'A1', describe: 'COUNT over the declared pair (S1\'s fields)', covered: true,
    build: (c) => c.where('a', '==', 'x').where('b', '>', 0).count() },
  { id: 'A2', describe: 'COUNT over the undeclared pair (S6\'s fields)', covered: false,
    build: (c) => c.where('a', '==', 'x').where('n', '>', 0).count() },
  { id: 'A3', describe: 'SUM(amount) over the declared pair', covered: true,
    build: (c) => c.where('a', '==', 'x').where('b', '>', 0).aggregate({ s: AggregateField.sum('amount') }) },
  { id: 'A4', describe: 'SUM(amount) over the undeclared pair', covered: false,
    build: (c) => c.where('a', '==', 'x').where('n', '>', 0).aggregate({ s: AggregateField.sum('amount') }) },
  { id: 'A5', describe: 'AVG(amount) over the declared pair', covered: true,
    build: (c) => c.where('a', '==', 'x').where('b', '>', 0).aggregate({ m: AggregateField.average('amount') }) },
  { id: 'A6', describe: 'AVG(amount) over the undeclared pair', covered: false,
    build: (c) => c.where('a', '==', 'x').where('n', '>', 0).aggregate({ m: AggregateField.average('amount') }) },
];

// The guard `check` applies, for the reason `check` applies it. An emulator enforces no composite
// indexes at all, so every shape would answer served through either oracle regardless of selection.
for (const name of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN']) {
  if (process.env[name] !== undefined && process.env[name] !== '') {
    process.stderr.write(`probe-aggregation: refusing to run while ${name} is set\n`);
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
  process.stderr.write(`probe-aggregation: ${error.message}\n`);
  process.stderr.write(
    'probe-aggregation: usage: node probe/aggregation.mjs <project> [database] ' +
      '[--expect-uncovered <ids>] [--expect-served <ids>]\n',
  );
  process.exit(2);
}

const db = new Firestore({ projectId: project, databaseId: database });
const collection = db.collection(COLLECTION);

const FAILED_PRECONDITION = 9;
const INVALID_ARGUMENT = 3;

/**
 * The two oracles, `read` first as `oracle.mjs` orders them. Neither closure reads what its call
 * resolved with, for the same reason `oracle.mjs`'s does not: the question is answered entirely by
 * whether the call threw, which is `askOracle`'s own discipline.
 */
const ORACLES = [
  { name: 'read', ask: (query) => query.get() },
  { name: 'explain', ask: (query) => query.explain({ analyze: false }) },
];

const results = [];
for (const shape of SHAPES) {
  for (const oracle of ORACLES) {
    let outcome;
    let query;
    try {
      // No `.limit()` anywhere on this path — see the module docblock for why that absence is
      // exactly what this script exists to exercise rather than route around.
      query = shape.build(collection);
    } catch (error) {
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
    process.stderr.write(`probe-aggregation: ${shape.id} ${oracle.name.padEnd(7)} ${outcome.verdict}\n`);
  }
}

const { findings, unreliable, unexpected, exitCode } = summarise(results, SHAPES, expected);

process.stderr.write('\n');
for (const line of summaryLines({
  findings,
  unreliable,
  unexpected,
  claim: 'the aggregation-replay claims (issue #93): selection matches the inner query, and the two oracles agree',
  unit: 'oracles',
})) {
  process.stderr.write(`probe-aggregation: ${line}\n`);
}

process.stdout.write(
  `${JSON.stringify({ project, database, expected: Object.fromEntries(expected), results, findings, unreliable, unexpected }, null, 2)}\n`,
);
// Set before the teardown, for the reason `oracle.mjs` and `limit.mjs` set it before their own.
process.exitCode = exitCode;
try {
  await db.terminate();
} catch (error) {
  process.stderr.write(`probe-aggregation: closing the client failed: ${error?.message ?? String(error)}\n`);
  process.stdout.write('', () => process.exit(process.exitCode));
}
