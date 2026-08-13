import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIELD_OPERATORS,
  UNARY_OPERATORS,
  isReplayComposite,
  operandFor,
  planReplay,
  toQueryShape,
} from '../dist/index.js';

/** A corpus entry, built the way a corpus builds one, so the tests read normalised trees. */
function shape({ collectionGroup = 'orders', queryScope = 'COLLECTION', where = null, orderBy = [] }) {
  return toQueryShape({ collectionGroup, queryScope, where, orderBy });
}

test('a unary filter carries no operand', () => {
  for (const op of UNARY_OPERATORS) {
    assert.deepEqual(operandFor('status', op), { arity: 'none' }, op);
  }
});

test('IN, NOT_IN, and ARRAY_CONTAINS_ANY compare against a one-element array', () => {
  for (const op of ['IN', 'NOT_IN', 'ARRAY_CONTAINS_ANY']) {
    assert.deepEqual(operandFor('tier', op), { arity: 'array', type: 'scalar' }, op);
  }
});

test('every other field operator compares against a single scalar', () => {
  const list = new Set(['IN', 'NOT_IN', 'ARRAY_CONTAINS_ANY']);
  for (const op of FIELD_OPERATORS.filter((candidate) => !list.has(candidate))) {
    assert.deepEqual(operandFor('amount', op), { arity: 'single', type: 'scalar' }, op);
  }
});

test('the field operators are covered exhaustively, so a new one cannot pass unnoticed', () => {
  // The vocabulary is closed (SPEC §7), and this is the assertion that notices if it stops being
  // the list this module was written against. Spelled as the whole expected mapping rather than as
  // `arity !== 'none'`: the distinction that decides whether replay sends a scalar where Firestore
  // demands an array is `single` vs `array`, which a not-`none` assertion cannot see.
  const expected = {
    LESS_THAN: 'single',
    LESS_THAN_OR_EQUAL: 'single',
    GREATER_THAN: 'single',
    GREATER_THAN_OR_EQUAL: 'single',
    EQUAL: 'single',
    NOT_EQUAL: 'single',
    ARRAY_CONTAINS: 'single',
    IN: 'array',
    ARRAY_CONTAINS_ANY: 'array',
    NOT_IN: 'array',
  };
  assert.deepEqual(FIELD_OPERATORS.toSorted(), Object.keys(expected).toSorted());
  for (const [op, arity] of Object.entries(expected)) {
    assert.deepEqual(operandFor('amount', op), { arity, type: 'scalar' }, op);
  }
  for (const op of UNARY_OPERATORS) {
    assert.deepEqual(operandFor('amount', op), { arity: 'none' }, op);
  }
});

test('a __name__ filter takes a reference rather than a scalar', () => {
  // Firestore validates the operand's type against the document key before it selects an index, so
  // a string here is an INVALID_ARGUMENT and never reaches the question replay is asking.
  assert.deepEqual(operandFor('__name__', 'EQUAL'), { arity: 'single', type: 'reference' });
  assert.deepEqual(operandFor('__name__', 'GREATER_THAN'), { arity: 'single', type: 'reference' });
});

test('arity and operand type compose on __name__', () => {
  // Neither rule states this alone: the list operators give the arity, the field path gives the type.
  assert.deepEqual(operandFor('__name__', 'IN'), { arity: 'array', type: 'reference' });
  assert.deepEqual(operandFor('__name__', 'NOT_IN'), { arity: 'array', type: 'reference' });
});

test('a unary filter on __name__ still carries no operand', () => {
  assert.deepEqual(operandFor('__name__', 'IS_NULL'), { arity: 'none' });
});

test('a field merely named like the document key is an ordinary scalar', () => {
  assert.deepEqual(operandFor('__name__x', 'EQUAL'), { arity: 'single', type: 'scalar' });
  assert.deepEqual(operandFor('a.__name__', 'EQUAL'), { arity: 'single', type: 'scalar' });
  assert.deepEqual(operandFor('name', 'EQUAL'), { arity: 'single', type: 'scalar' });
});

test('an entry whose root composite has no children replays with where omitted', () => {
  // Not as an empty AND: a wire CompositeFilter must carry at least one filter, and an empty one
  // fails with INVALID_ARGUMENT — which is not a FAILED_PRECONDITION and says nothing about indexes.
  const plan = planReplay(shape({ where: null }));
  assert.equal(plan.where, null);
});

test('a childless root OR is refused rather than replayed as an unfiltered query', () => {
  // The empty AND above is the wrapper normaliseRoot manufactures for "no where at all". An empty
  // OR is a filter that was actually on the wire and matches nothing; replaying it as an omitted
  // where would issue an unfiltered query, which needs no index, succeeds, and reports the entry
  // covered when nothing was checked. A false clean verdict is what SPEC §2 exists to prevent.
  assert.throws(() => planReplay(shape({ where: { op: 'OR', filters: [] } })), {
    name: 'ReplayError',
  });
});

test('a childless composite below the root is refused rather than planned', () => {
  // Reachable from a committed corpus: parseCorpus accepts `filters: []` at any depth, and the
  // entry passes the normalised-form gate. Planned, it would send a CompositeFilter with zero
  // filters — INVALID_ARGUMENT, which carries no information about the index set.
  // Only a childless composite whose op DIFFERS from its parent's survives normalisation:
  // normaliseFilter splices a same-op child into its parent, and an empty one then vanishes.
  for (const [parent, child] of [
    ['AND', 'OR'],
    ['OR', 'AND'],
  ]) {
    const where = { op: parent, filters: [{ fieldPath: 'a', op: 'EQUAL' }, { op: child, filters: [] }] };
    assert.throws(() => planReplay(shape({ where })), { name: 'ReplayError' }, `${parent}(${child}())`);
  }
});

test('a same-op childless composite is absorbed by normalisation before planning sees it', () => {
  // The other half of the rule above, pinned so the refusal test cannot quietly start passing for
  // the wrong reason: this entry is plannable precisely because the empty OR no longer exists.
  const where = { op: 'OR', filters: [{ fieldPath: 'a', op: 'EQUAL' }, { op: 'OR', filters: [] }] };
  const plan = planReplay(shape({ where }));
  assert.deepEqual(plan.where, {
    op: 'OR',
    filters: [{ fieldPath: 'a', op: 'EQUAL', operand: { arity: 'single', type: 'scalar' } }],
  });
});

test('a single-filter query keeps the AND the root was wrapped in', () => {
  const plan = planReplay(shape({ where: { fieldPath: 'status', op: 'EQUAL' } }));
  assert.ok(isReplayComposite(plan.where));
  assert.equal(plan.where.op, 'AND');
  assert.deepEqual(plan.where.filters, [
    { fieldPath: 'status', op: 'EQUAL', operand: { arity: 'single', type: 'scalar' } },
  ]);
});

test('operands are planned at every depth of a nested tree', () => {
  const plan = planReplay(
    shape({
      where: {
        op: 'AND',
        filters: [
          { fieldPath: 'status', op: 'EQUAL' },
          {
            op: 'OR',
            filters: [
              { fieldPath: 'tier', op: 'IN' },
              { fieldPath: '__name__', op: 'GREATER_THAN' },
            ],
          },
        ],
      },
    }),
  );
  // Asserted as the whole tree, not as a flattened bag of operands: a planner that spliced the OR
  // into its parent AND would produce the same bag, and would replay `a AND b AND c` for a query
  // the suite issued as `a AND (b OR c)` — a different query, with a different index requirement.
  // Child order is the normalised one (shape.ts sorts by the serialised form, code point wise).
  assert.deepEqual(plan.where, {
    op: 'AND',
    filters: [
      {
        op: 'OR',
        filters: [
          { fieldPath: '__name__', op: 'GREATER_THAN', operand: { arity: 'single', type: 'reference' } },
          { fieldPath: 'tier', op: 'IN', operand: { arity: 'array', type: 'scalar' } },
        ],
      },
      { fieldPath: 'status', op: 'EQUAL', operand: { arity: 'single', type: 'scalar' } },
    ],
  });
  assert.ok(isReplayComposite(plan.where.filters[0]), 'the nested OR is still a composite');
  assert.equal(isReplayComposite(plan.where.filters[1]), false, 'a leaf is not a composite');
});

test('a top-level OR is planned as an OR rather than wrapped', () => {
  const plan = planReplay(
    shape({
      where: {
        op: 'OR',
        filters: [
          { fieldPath: 'tier', op: 'EQUAL' },
          { fieldPath: 'tier', op: 'EQUAL' },
        ],
      },
    }),
  );
  assert.equal(plan.where.op, 'OR');
  // Repeated children are kept: two disjuncts is the query that was issued.
  assert.equal(plan.where.filters.length, 2);
});

test('sort order passes through exactly as the corpus recorded it', () => {
  // SPEC §7, Implicit fields are not materialised: neither adding nor removing a __name__ order.
  const orderBy = [
    { fieldPath: 'amount', direction: 'DESCENDING' },
    { fieldPath: 'createdAt', direction: 'ASCENDING' },
  ];
  const plan = planReplay(shape({ orderBy }));
  assert.deepEqual(plan.orderBy, orderBy);
});

test('an inequality query whose sort order was already normalised by the SDK is not rewritten', () => {
  const orderBy = [
    { fieldPath: 'age', direction: 'ASCENDING' },
    { fieldPath: '__name__', direction: 'ASCENDING' },
  ];
  const plan = planReplay(shape({ where: { fieldPath: 'age', op: 'GREATER_THAN' }, orderBy }));
  assert.deepEqual(plan.orderBy, orderBy);
});

test('the collection and its scope are carried to the plan', () => {
  const plan = planReplay(shape({ collectionGroup: 'orders', queryScope: 'COLLECTION_GROUP' }));
  assert.equal(plan.collectionGroup, 'orders');
  assert.equal(plan.queryScope, 'COLLECTION_GROUP');
});

test('a field path holding key delimiters survives planning verbatim', () => {
  // The key escapes these; the plan must not, because the path is sent to Firestore as written.
  const plan = planReplay(shape({ where: { fieldPath: 'a:b|c', op: 'EQUAL' } }));
  assert.equal(plan.where.filters[0].fieldPath, 'a:b|c');
});
