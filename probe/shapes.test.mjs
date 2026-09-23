/**
 * The shapes, read off the wire rather than off their descriptions.
 *
 * Issue #69 names two classes step 5b did not reach — a disjunction and a `COLLECTION_GROUP` scope —
 * and S9–S12 exist to reach them. A shape whose `describe` says "collection group" but whose builder
 * queried the root collection would re-run the old reading under a new name, and the run would
 * report the gap closed. Constructing a query opens no channel, so the request each shape sends can
 * be pinned here without a database.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { COLLECTION, SENTINEL, SHAPES } from './shapes.mjs';

const db = new Firestore({ projectId: 'indexwright-probe' });
const collection = db.collection(COLLECTION);
const values = {
  scalar: () => SENTINEL,
  list: () => [SENTINEL],
  ref: () => collection.doc(SENTINEL),
};

/** The structured query one shape sends, as `limit.mjs` sends it. */
function wire(id) {
  const shape = SHAPES.find((s) => s.id === id);
  assert.ok(shape, `${id} is not a shape`);
  return shape.build(collection, values).limit(1).toProto().structuredQuery;
}

const scopeOf = (query) => (query.from[0].allDescendants === true ? 'COLLECTION_GROUP' : 'COLLECTION');
const topOp = (query) => query.where?.compositeFilter?.op ?? 'FIELD';

test('each class issue #69 names is reached by one shape served and one not', () => {
  const reached = (predicate) =>
    SHAPES.filter((shape) => predicate(wire(shape.id))).map((shape) => `${shape.id}:${shape.covered}`);
  // Both predictions, because the reading that matters to §2 is the uncovered one: only a shape that
  // should fail can show a limit rescuing it into served.
  assert.deepEqual(reached((q) => scopeOf(q) === 'COLLECTION_GROUP'), ['S9:true', 'S10:false']);
  assert.deepEqual(reached((q) => topOp(q) === 'OR'), ['S11:true', 'S12:false']);
});

/** Every operator a structured query's filter tree carries, leaves only. */
function operators(node) {
  if (node === undefined) return [];
  if (node.compositeFilter !== undefined) return node.compositeFilter.filters.flatMap(operators);
  return [(node.fieldFilter ?? node.unaryFilter).op];
}

test('each operator class issue #89 names is reached by one shape served and one not', () => {
  for (const [op, expected] of [
    ['NOT_IN', ['S13:true', 'S14:false']],
    ['ARRAY_CONTAINS_ANY', ['S15:true', 'S16:false']],
    ['IS_NOT_NULL', ['S17:true', 'S18:false']],
    ['IS_NOT_NAN', ['S19:true', 'S20:false']],
  ]) {
    const reached = SHAPES.filter((shape) => operators(wire(shape.id).where).includes(op)).map(
      (shape) => `${shape.id}:${shape.covered}`,
    );
    assert.deepEqual(reached, expected, op);
  }
});

test('every shape queries the one collection id the seed writes, and none leaves it', () => {
  for (const shape of SHAPES) {
    const query = wire(shape.id);
    assert.equal(query.from.length, 1, shape.id);
    assert.equal(query.from[0].collectionId, COLLECTION, shape.id);
  }
});

test('the limit is the one field the limited issuing adds', () => {
  // `limit.mjs` compares a shape with and without `.limit(1)`. If the SDK moved anything else on the
  // wire along with it — an order, a scope — the run would be comparing two different questions.
  for (const shape of SHAPES) {
    const bare = shape.build(collection, values).toProto().structuredQuery;
    const limited = wire(shape.id);
    assert.deepEqual(limited.limit, { value: 1 }, shape.id);
    const { limit, ...rest } = limited;
    assert.deepEqual(rest, bare, shape.id);
  }
});
