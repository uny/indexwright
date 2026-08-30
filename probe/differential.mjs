/**
 * The instrument for SPEC §7's claim: that index selection is a function of field paths, operators
 * and directions, and not of the value compared against.
 *
 * `check` cannot test this. It only ever sends the one synthesised value, so it would agree with
 * itself whatever the truth is. This issues each shape in `shapes.mjs` repeatedly, changing only
 * the operands, and compares the verdicts.
 *
 * **The falsification condition, stated exactly:** for one shape, two variants that both reached
 * the backend disagree on served versus `FAILED_PRECONDITION`. A variant the backend rejected as
 * `INVALID_ARGUMENT` never reached the question and is excluded from the comparison — but it is
 * reported, because a shape where only the sentinel is a valid operand is worth knowing about even
 * though it is not a counterexample.
 *
 * If the claim is false, `check` reports `FAILED_PRECONDITION` where a real query would have
 * succeeded — a false positive of exactly the kind SPEC §2 forbids acting on, and one that would
 * make every verdict the verb reaches suspect.
 *
 * **What this does not test, stated so a `constant` verdict is not read as more than it is.** A
 * shape's scalar slots are all filled from the *same* provider call, so a two-filter shape is only
 * ever issued with both operands of the same type: `a == 'beta'` with `b > 'beta'`, or `a == 42`
 * with `b > 42`, never `a == 'beta'` with `b > 42`. Selection that turned on the *combination* of
 * operand types rather than on any one of them would survive this instrument and be reported
 * `constant`. Varying the slots independently is a cross-product rather than a list, and is not
 * attempted here; what is claimed is only that selection does not turn on the operands moving
 * together, which is the axis replay actually exercises — `replay.ts` fills every slot from one
 * sentinel too.
 *
 * Nothing here imports the classifier `replay.ts` uses. The two are meant to be independent: a
 * shared classifier that read a status wrongly would read it wrongly for both, and this instrument
 * exists to be a second opinion about what the database said.
 *
 * Usage: node probe/differential.mjs <project> [database]
 *          [--expect-uncovered <ids>] [--expect-served <ids>]
 *
 * The two `--expect-` flags take comma-separated shape ids and are how the runbook's expected
 * reading reaches the instrument. A shape that answers against its expectation exits non-zero
 * instead of printing a line an operator has to notice, which is the contract `check` keeps and this
 * probe did not: two of its four documented stop conditions were carried by the summary alone, and
 * the one that matters most is read three minutes before a deploy.
 *
 * **The predictions are supplied, never held here.** Which shapes a bare target serves is the sort
 * of thing this run exists to observe, and a prediction compiled into the instrument that blocks the
 * run is worse than one written in prose that does not: an earlier revision of the runbook expected
 * every non-S7 shape uncovered on a bare target, which is false — Firestore merges single-field
 * indexes for equality-only shapes — and would have diagnosed a correct run as a dirty target. A
 * shape named by neither flag is unconstrained, which is what S2 and S5 have to stay.
 */

import { Firestore, Timestamp } from '@google-cloud/firestore';
import { COLLECTION, SENTINEL, SHAPES, seededId } from './shapes.mjs';
import { summarise, summaryLines } from './summarise.mjs';

// The guard `check` applies, for the reason `check` applies it: each of these redirects the client
// whatever target it is given, so the named database would be announced and something else
// measured. An emulator enforces no composite indexes at all, which would report every shape served.
for (const name of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN']) {
  if (process.env[name] !== undefined && process.env[name] !== '') {
    process.stderr.write(`probe-differential: refusing to run while ${name} is set\n`);
    process.exit(2);
  }
}

const argv = process.argv.slice(2);
const positional = [];
/** Expected verdicts by shape id, from the `--expect-` flags. Absent means unconstrained. */
const expected = new Map();

function die(message) {
  process.stderr.write(`probe-differential: ${message}\n`);
  process.stderr.write(
    'probe-differential: usage: node probe/differential.mjs <project> [database] ' +
      '[--expect-uncovered <ids>] [--expect-served <ids>]\n',
  );
  process.exit(2);
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const verdict =
    arg === '--expect-uncovered' ? 'uncovered' : arg === '--expect-served' ? 'served' : undefined;
  if (verdict === undefined) {
    // A flag this script does not define is refused rather than taken as the project. A typo'd
    // `--expect-uncoverd` read as a positional would name a project that does not exist, which is a
    // clearer failure than the one below it — but a *third* positional would be silently ignored,
    // and that is how an expectation goes unenforced while the run reports having enforced it.
    if (arg.startsWith('-')) die(`${arg} is not an option this script defines`);
    positional.push(arg);
    continue;
  }
  const list = argv[i + 1];
  if (list === undefined || list.startsWith('-')) die(`${arg} needs a comma-separated list of shape ids`);
  i += 1;
  for (const id of list.split(',').map((value) => value.trim()).filter((value) => value !== '')) {
    // Refused rather than dropped, for the reason `suite.mjs` refuses an unknown PROBE_SHAPES id:
    // the ids are retyped by hand from the runbook, and an expectation naming a shape that does not
    // exist is an expectation that can never fail — the run then reports a stop rule it never ran.
    if (!SHAPES.some((shape) => shape.id === id)) {
      die(`${arg} names ${id}, which is not a shape — known ids are ${SHAPES.map((s) => s.id).join(', ')}`);
    }
    // A shape named by both flags cannot be satisfied, and taking the last one silently would let a
    // copy-paste between the two runbook steps enforce the opposite of what was written.
    const already = expected.get(id);
    if (already !== undefined && already !== verdict) die(`${id} is expected both served and uncovered`);
    expected.set(id, verdict);
  }
}

if (positional.length > 2) die(`unexpected argument ${positional[2]}`);
const [project, database = '(default)'] = positional;
if (project === undefined) die('a project is required');

const db = new Firestore({ projectId: project, databaseId: database });
const collection = db.collection(COLLECTION);

/**
 * The operands each shape is issued with.
 *
 * `sentinel` is first and is exactly what `replay.ts` sends, so every other row is read as "what
 * changes when the value stops being the one indexwright invents". The types are chosen to span
 * Firestore's own value-type ordering — a string, a number, a boolean, a timestamp, a reference, an
 * array, a map — because if selection turned on anything about the value, the type is where it
 * would turn.
 *
 * `null` and `NaN` are deliberately absent. The SDK converts an equality against either into a
 * *unary* filter on the wire, so substituting one does not vary the operand of a shape — it records
 * a different shape. S5 covers the unary form as its own entry instead.
 */
const VARIANTS = [
  { name: 'sentinel', scalar: () => SENTINEL, list: () => [SENTINEL] },
  { name: 'string', scalar: () => 'beta', list: () => ['beta'] },
  { name: 'number', scalar: () => 42, list: () => [42] },
  { name: 'boolean', scalar: () => true, list: () => [true] },
  { name: 'timestamp', scalar: () => Timestamp.fromMillis(1700000000000), list: () => [Timestamp.fromMillis(1700000000000)] },
  { name: 'reference', scalar: () => collection.doc('some-document'), list: () => [collection.doc('some-document')] },
  { name: 'array', scalar: () => [1, 2], list: () => [[1, 2]] },
  { name: 'map', scalar: () => ({ k: 1 }), list: () => [{ k: 1 }] },
  // The arity variants. Same operand type as `sentinel`, differing only in how many values the list
  // carries — which is the one thing the corpus discards and replay therefore has to invent.
  { name: 'list-of-three', only: 'arity', scalar: () => SENTINEL, list: () => [SENTINEL, 'beta', 'gamma'] },
  { name: 'list-of-ten', only: 'arity', scalar: () => SENTINEL, list: () => [SENTINEL, ...Array.from({ length: 9 }, (_, i) => `v${i}`)] },
  // The reference variants, for the `__name__` shape. A key filter's operand is validated against
  // the collection being queried before an index is selected, so the interesting axis is which
  // document it names rather than what type it is — which means one of them has to name a document
  // that is *there*. `ref-present` is that one, and `seededId` is imported rather than spelled again
  // so it cannot drift from the ids `seed.mjs` wrote.
  //
  // There is deliberately no `ref-sentinel` here: for S7 it would be byte-for-byte the general
  // `sentinel` variant at the top of this list — same scalar, and `values.ref` already defaults to
  // `doc(SENTINEL)` — so it added a row to the operand count without adding an operand, and that
  // count is what an operator reads as the strength of the §7 evidence.
  { name: 'ref-present', only: 'reference', ref: () => collection.doc(seededId(0)) },
  { name: 'ref-missing', only: 'reference', ref: () => collection.doc('does-not-exist') },
];

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

/** Whether this variant applies to this shape. */
function applies(shape, variant) {
  if (variant.only === undefined) return shape.varies !== 'nothing' || variant.name === 'sentinel';
  return variant.only === shape.varies;
}

const results = [];
for (const shape of SHAPES) {
  for (const variant of VARIANTS) {
    if (!applies(shape, variant)) continue;
    // A variant that does not define the provider a shape asks for cannot be built, and building it
    // with `undefined` would send a filter the shape does not describe.
    const values = {
      scalar: variant.scalar ?? (() => SENTINEL),
      list: variant.list ?? (() => [SENTINEL]),
      ref: variant.ref ?? (() => collection.doc(SENTINEL)),
    };
    let outcome;
    try {
      outcome = await ask(shape.build(collection, values));
    } catch (error) {
      // Thrown while *building* rather than while running: not an answer, and not a statement about
      // the index set. Recorded as its own kind for the same reason `replay.ts` has `unbuildable`.
      outcome = { verdict: 'unbuildable', message: error?.message ?? String(error) };
    }
    results.push({ shape: shape.id, variant: variant.name, ...outcome });
    process.stderr.write(
      `probe-differential: ${shape.id} ${variant.name.padEnd(14)} ${outcome.verdict}` +
        (outcome.read === undefined ? '' : ` (${outcome.read} documents read)`) +
        '\n',
    );
  }
}

const { findings, unreliable, unexpected, exitCode } = summarise(results, SHAPES, expected);

process.stderr.write('\n');
for (const line of summaryLines({ findings, unreliable, unexpected })) {
  process.stderr.write(`probe-differential: ${line}\n`);
}

process.stdout.write(
  `${JSON.stringify({ project, database, expected: Object.fromEntries(expected), results, findings, unreliable, unexpected }, null, 2)}\n`,
);
await db.terminate();

// Set rather than computed here: the rule lives in `summarise.mjs`, where it is tested.
process.exitCode = exitCode;
