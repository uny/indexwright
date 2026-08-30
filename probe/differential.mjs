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
 */

import { Firestore, Timestamp } from '@google-cloud/firestore';
import { COLLECTION, SENTINEL, SHAPES, seededId } from './shapes.mjs';

// The guard `check` applies, for the reason `check` applies it: each of these redirects the client
// whatever target it is given, so the named database would be announced and something else
// measured. An emulator enforces no composite indexes at all, which would report every shape served.
for (const name of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN']) {
  if (process.env[name] !== undefined && process.env[name] !== '') {
    process.stderr.write(`probe-differential: refusing to run while ${name} is set\n`);
    process.exit(2);
  }
}

const [project, database = '(default)'] = process.argv.slice(2);
if (project === undefined) {
  process.stderr.write('probe-differential: usage: node probe/differential.mjs <project> [database]\n');
  process.exit(2);
}

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

// The comparison. Only variants that reached the backend are compared, and a shape with fewer than
// two of them is reported as untested rather than as agreeing with itself.
const findings = [];
for (const shape of SHAPES) {
  const answered = results.filter((r) => r.shape === shape.id && (r.verdict === 'served' || r.verdict === 'uncovered'));
  const verdicts = new Set(answered.map((r) => r.verdict));
  if (shape.varies === 'nothing') {
    // For a shape whose filters are *all* unary, and no shape currently is: there would then be
    // nothing about it for a value to change, and counting it as untested would report a hole where
    // the question does not arise. It would still be run, for the three questions that are not §7's.
    //
    // S5 used to set this and should not have. It pairs a unary `IS_NULL` with an ordinary equality,
    // so it has an operand; marking the whole shape as having none excluded it from the comparison
    // and printed `has no operand to vary` over a shape that had simply never been varied. The test
    // is whether *every* filter is unary, not whether any is.
    findings.push({ shape: shape.id, kind: 'not-applicable', verdict: [...verdicts][0] ?? 'none' });
  } else if (answered.length < 2) {
    findings.push({ shape: shape.id, kind: 'untested', reached: answered.length });
  } else if (verdicts.size > 1) {
    findings.push({
      shape: shape.id,
      kind: 'claim-falsified',
      byVariant: Object.fromEntries(answered.map((r) => [r.variant, r.verdict])),
    });
  } else {
    findings.push({ shape: shape.id, kind: 'constant', verdict: [...verdicts][0], variants: answered.length });
  }
}

const falsified = findings.filter((f) => f.kind === 'claim-falsified');
const untested = findings.filter((f) => f.kind === 'untested');

process.stderr.write('\n');
for (const finding of findings) {
  if (finding.kind === 'constant') {
    process.stderr.write(`probe-differential: ${finding.shape} constant across ${finding.variants} operands: ${finding.verdict}\n`);
  } else if (finding.kind === 'not-applicable') {
    process.stderr.write(`probe-differential: ${finding.shape} has no operand to vary; answered ${finding.verdict}\n`);
  } else if (finding.kind === 'untested') {
    process.stderr.write(`probe-differential: ${finding.shape} UNTESTED — only ${finding.reached} operand reached the backend\n`);
  } else {
    process.stderr.write(`probe-differential: ${finding.shape} FALSIFIES SPEC §7: ${JSON.stringify(finding.byVariant)}\n`);
  }
}

process.stdout.write(`${JSON.stringify({ project, database, results, findings }, null, 2)}\n`);
await db.terminate();

// 1 means the claim did not survive, which is a finding rather than a failure of this script; 2
// means the run could not answer, and takes precedence — the same contract `check` uses.
if (untested.length > 0) process.exitCode = 2;
else if (falsified.length > 0) process.exitCode = 1;
