/**
 * The query shapes both instruments use, defined once.
 *
 * `suite.mjs` issues them at the emulator so that `record` captures a corpus; `differential.mjs`
 * issues them at the real database with varied operands. Sharing the definitions is the point: the
 * corpus `check` replays and the shapes the differential probe varies cannot drift apart, so a
 * verdict from one instrument is about the same query as a verdict from the other.
 *
 * `covered` is a *prediction* about the candidate set in `firestore.indexes.json`, written down so
 * the run can falsify it. It is not consulted by either instrument.
 */

/**
 * A shape's value slots are filled by a provider rather than by literals, because the differential
 * probe's whole purpose is to fill them differently each time. `suite.mjs` passes a provider that
 * always answers with the sentinel, since capture records no values at all.
 *
 * The providers take no arguments: `list()` returns a list whose *length* is chosen by the caller,
 * not by the shape. The corpus does not record that length — an `IN` against three values is
 * recorded, and replayed, identically to an `IN` against one — so if index selection turns on it,
 * replay reports a verdict for a query the suite never issued. That is the sharpest way SPEC §7's
 * claim could be false, and it is why arity is a *variant* in `differential.mjs` rather than a
 * parameter here: a shape that chose its own arity would be a different shape, not the same one
 * with a different operand.
 */
export const SHAPES = [
  {
    id: 'S1',
    describe: 'an equality and an inequality, ordered by the inequality field',
    covered: true,
    build: (c, v) => c.where('a', '==', v.scalar()).where('b', '>', v.scalar()).orderBy('b'),
  },
  {
    id: 'S2',
    describe: 'an equality and an IN — the shape whose operand arity the corpus discards',
    covered: true,
    varies: 'arity',
    build: (c, v) => c.where('a', '==', v.scalar()).where('b', 'in', v.list()),
  },
  {
    id: 'S3',
    describe: 'an array-contains and an equality',
    covered: true,
    build: (c, v) => c.where('tags', 'array-contains', v.scalar()).where('a', '==', v.scalar()),
  },
  {
    id: 'S4',
    describe: 'an equality and a NOT_EQUAL — the entry issue #43 says reads the whole collection',
    covered: true,
    build: (c, v) => c.where('a', '==', v.scalar()).where('b', '!=', v.scalar()),
  },
  {
    id: 'S5',
    describe: 'an equality and a unary IS_NULL, whose null half carries no operand to vary',
    covered: true,
    // The `b == null` half is unary and cannot be varied — swapping the `null` for anything else
    // records a different shape rather than the same shape with a different value. The `a ==` half
    // is an ordinary operand like any other, so this shape *does* take part in the §7 comparison and
    // deliberately carries no `varies: 'nothing'`.
    //
    // It did carry one, which excluded it: `applies` then admitted only the `sentinel` variant, and
    // the shape was reported `has no operand to vary` rather than tested. One shape in eight was
    // silently outside the experiment the whole instrument exists to run, on the premise that a
    // query with one unary filter has no operands at all.
    build: (c, v) => c.where('a', '==', v.scalar()).where('b', '==', null),
  },
  {
    id: 'S6',
    describe: 'an equality and an inequality on a field pair the candidate set does not declare',
    covered: false,
    build: (c, v) => c.where('a', '==', v.scalar()).where('n', '>', v.scalar()),
  },
  {
    id: 'S7',
    describe: 'an equality and an inequality on the document key',
    covered: true,
    varies: 'reference',
    build: (c, v) => c.where('a', '==', v.scalar()).where('__name__', '>', v.ref()),
  },
  {
    id: 'S8',
    describe: 'an equality ordered by a second field descending',
    covered: false,
    build: (c, v) => c.where('a', '==', v.scalar()).orderBy('b', 'desc'),
  },
];

/** The collection every shape is issued against. */
export const COLLECTION = 'probe';

/**
 * The id of the `i`th seeded document.
 *
 * Here rather than in `seed.mjs` for the reason the shapes themselves are here: `differential.mjs`
 * needs to name a document the seed actually wrote, and a second spelling of the format would drift
 * from the one that wrote it. A `ref` variant naming a document that does not exist cannot test the
 * axis it was added for.
 */
export function seededId(i) {
  return `doc-${String(i).padStart(5, '0')}`;
}

/**
 * The value `replay.ts` synthesises, re-exported rather than copied.
 *
 * A copy would defeat the differential probe: its `sentinel` row exists to be *literally what
 * indexwright sends*, so that every other row reads as "what changes when the value stops being
 * that one". A second spelling of it here would drift, and the probe would then report that the
 * claim holds for a value the verb does not use.
 *
 * Requires `npm run build`, which the runbook asks for first.
 */
export { REPLAY_SENTINEL as SENTINEL } from '../packages/record/dist/index.js';
