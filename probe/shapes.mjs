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
 * `list(n)` takes a length because the corpus does not record one: an `IN` against three values is
 * recorded, and replayed, identically to an `IN` against one. If index selection turns on that
 * length, replay reports a verdict for a query the suite never issued — which is the sharpest way
 * SPEC §7's claim could be false, and the reason arity is a variant here rather than a constant.
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
    describe: 'an equality and a unary IS_NULL, which carries no operand to vary',
    covered: true,
    // Excluded from the differential comparison by `varies: 'nothing'`: there is no operand here to
    // change, and swapping the `null` for anything else records a different shape rather than the
    // same shape with a different value. It is run for the other three questions, not for §7.
    varies: 'nothing',
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
