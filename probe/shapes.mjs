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

import { Filter } from '@google-cloud/firestore';

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
  // S9–S12 are the classes S1–S8 do not reach (issue #69): every shape above is a conjunction
  // against a single collection, and replay also sends a disjunction and a `COLLECTION_GROUP` scope
  // with `limit(1)` on. Each class gets a shape predicted served and one predicted uncovered, because
  // the direction §2 cares about is the second: a limit that rescued an uncovered query into served
  // is the false clean verdict, and only an uncovered shape can show it happening.
  //
  // The collection-group shapes query the group of the same id, so the seeded root collection is a
  // member of it and `seed.mjs` needs no second location. Built from `c` rather than from a second
  // parameter, so the three instruments that call `build` need not know which scope a shape has.
  {
    id: 'S9',
    describe: 'an array-contains and an equality at COLLECTION_GROUP scope',
    covered: true,
    // Served, if at all, by the `COLLECTION_GROUP` entry in `firestore.indexes.json` and nothing
    // else: Firestore creates no collection-group single-field indexes by default, so the merge
    // that serves S3 without a composite has nothing to merge here. A single-field shape is
    // deliberately not used — it would be served by a `fieldOverrides` entry, the half of the
    // declaration #53 says `check` cannot see.
    build: (c, v) =>
      c.firestore.collectionGroup(c.id).where('tags', 'array-contains', v.scalar()).where('a', '==', v.scalar()),
  },
  {
    id: 'S10',
    describe: "S1 at COLLECTION_GROUP scope, where only S1's COLLECTION-scope index is declared",
    covered: false,
    // The pair S1 is served by is declared at `COLLECTION` scope only, so this is uncovered unless
    // an index of one scope serves a query of the other — which is itself worth seeing refused.
    build: (c, v) =>
      c.firestore.collectionGroup(c.id).where('a', '==', v.scalar()).where('b', '>', v.scalar()).orderBy('b'),
  },
  {
    id: 'S11',
    describe: 'a disjunction whose disjuncts the declared (a, b) index serves',
    covered: true,
    build: (c, v) =>
      c.where(
        Filter.or(
          Filter.and(Filter.where('a', '==', v.scalar()), Filter.where('b', '>', v.scalar())),
          Filter.and(Filter.where('a', '==', v.scalar()), Filter.where('b', '<', v.scalar())),
        ),
      ),
  },
  {
    id: 'S12',
    describe: 'a disjunction one of whose disjuncts is an equality and an inequality on an undeclared pair',
    covered: false,
    // Uncovered for S6's reason — `(n, b)` is not declared — with `b` kept as the only inequality
    // field. Negations, the array operators, and inequalities on two different fields are kept out
    // of both disjunctions: a combination rejected as `INVALID_ARGUMENT` never reaches the question,
    // and an expectation of `uncovered` would then stop the run for a reason unrelated to the limit.
    build: (c, v) =>
      c.where(
        Filter.or(
          Filter.and(Filter.where('a', '==', v.scalar()), Filter.where('b', '>', v.scalar())),
          Filter.and(Filter.where('n', '==', v.scalar()), Filter.where('b', '>', v.scalar())),
        ),
      ),
  },
  // S13–S20 are the operator classes S1–S12 still do not reach (issue #89), a served and an uncovered
  // shape for each, on the set step 5c left deployed. The served ones put the operator on `b` beside
  // an equality on `a`, or on `tags`, where a declared index already answers; the uncovered ones move
  // it to `n`, which no index names — so no new index is needed.
  //
  // `NOT_IN` and `IS_NOT_NULL` are also two of the operators issue #43 is about: like `!=`, they
  // match every document that merely has the field, which is where the read bound matters.
  {
    id: 'S13',
    describe: 'an equality and a NOT_IN, on the declared (a, b)',
    covered: true,
    varies: 'arity',
    build: (c, v) => c.where('a', '==', v.scalar()).where('b', 'not-in', v.list()),
  },
  {
    id: 'S14',
    describe: 'an equality and a NOT_IN, on the undeclared (a, n)',
    covered: false,
    varies: 'arity',
    build: (c, v) => c.where('a', '==', v.scalar()).where('n', 'not-in', v.list()),
  },
  {
    id: 'S15',
    describe: 'an ARRAY_CONTAINS_ANY and an equality, on the declared (tags CONTAINS, a)',
    covered: true,
    varies: 'arity',
    build: (c, v) => c.where('tags', 'array-contains-any', v.list()).where('a', '==', v.scalar()),
  },
  {
    id: 'S16',
    describe: 'an ARRAY_CONTAINS_ANY and an inequality, on the undeclared (tags CONTAINS, n)',
    covered: false,
    varies: 'arity',
    build: (c, v) => c.where('tags', 'array-contains-any', v.list()).where('n', '>', v.scalar()),
  },
  // The unary halves carry no operand, as S5's does not; the `a ==` half is what the §7 comparison
  // varies, so these carry no `varies` either.
  {
    id: 'S17',
    describe: 'an equality and a unary IS_NOT_NULL, on the declared (a, b)',
    covered: true,
    build: (c, v) => c.where('a', '==', v.scalar()).where('b', '!=', null),
  },
  {
    id: 'S18',
    describe: 'an equality and a unary IS_NOT_NULL, on the undeclared (a, n)',
    covered: false,
    build: (c, v) => c.where('a', '==', v.scalar()).where('n', '!=', null),
  },
  {
    id: 'S19',
    describe: 'an equality and a unary IS_NOT_NAN, on the declared (a, b)',
    covered: true,
    build: (c, v) => c.where('a', '==', v.scalar()).where('b', '!=', NaN),
  },
  {
    id: 'S20',
    describe: 'an equality and a unary IS_NOT_NAN, on the undeclared (a, n)',
    covered: false,
    build: (c, v) => c.where('a', '==', v.scalar()).where('n', '!=', NaN),
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
