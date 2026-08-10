import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeRunQuery, toQueryShape } from '../dist/index.js';

/**
 * Real `RunQueryRequest` bytes, as `@google-cloud/firestore` serialises them.
 *
 * The expected keys below are written by hand rather than generated, so that the assertion is
 * about what the wire means and not about what this decoder currently does with it. Regenerate the
 * bytes with `scripts/capture-fixtures.mjs`.
 */
const { cases } = JSON.parse(
  readFileSync(fileURLToPath(new URL('fixtures/run-query.json', import.meta.url)), 'utf8'),
);

const EXPECTED_KEYS = new Map([
  [
    'equality and inequality with two sorts',
    'orders::COLLECTION::AND(amount:GREATER_THAN|status:EQUAL)::amount:DESCENDING|createdAt:ASCENDING',
  ],
  [
    'the same query with its filters written in the other order',
    'orders::COLLECTION::AND(amount:GREATER_THAN|status:EQUAL)::amount:DESCENDING|createdAt:ASCENDING',
  ],
  ['a collection group query', 'items::COLLECTION_GROUP::AND(sku:EQUAL)::qty:ASCENDING'],
  ['no filters and no sort', 'orders::COLLECTION::AND()::'],
  [
    'a disjunction nested under a conjunction',
    'orders::COLLECTION::AND(OR(tier:EQUAL|tier:EQUAL)|tags:ARRAY_CONTAINS)::',
  ],
  [
    'every field operator',
    'orders::COLLECTION::AND(a:LESS_THAN|b:LESS_THAN_OR_EQUAL|c:GREATER_THAN|' +
      'd:GREATER_THAN_OR_EQUAL|e:EQUAL|f:ARRAY_CONTAINS|g:IN|h:ARRAY_CONTAINS_ANY)::',
  ],
  ['a not-equal filter', 'orders::COLLECTION::AND(state:NOT_EQUAL)::'],
  ['a not-in filter', 'orders::COLLECTION::AND(state:NOT_IN)::'],
  [
    'null and NaN, which reach the wire as unary filters',
    'orders::COLLECTION::AND(deletedAt:IS_NULL|score:IS_NAN)::',
  ],
  ['not-null and not-NaN', 'orders::COLLECTION::AND(deletedAt:IS_NOT_NULL|score:IS_NOT_NAN)::'],
  ['a sort on the document key', 'orders::COLLECTION::AND()::__name__:DESCENDING'],
  [
    'a field path that holds the key delimiters',
    'orders::COLLECTION::AND(`weird\\:path\\|with\\(parens\\)`:EQUAL)::',
  ],
  ['a nested field path', 'orders::COLLECTION::AND(profile.city:EQUAL)::'],
]);

function decodeFixture(name) {
  const found = cases.find((entry) => entry.name === name);
  assert.ok(found, `fixture "${name}" is missing; regenerate scripts/capture-fixtures.mjs`);
  const result = decodeRunQuery(Buffer.from(found.message, 'base64'));
  assert.ok(result.ok, `expected "${name}" to decode, got ${result.ok ? '' : result.reason}`);
  return toQueryShape(result.query);
}

test('every captured request decodes to the shape it was written as', () => {
  assert.equal(cases.length, EXPECTED_KEYS.size, 'the fixture and the expectations disagree in size');
  for (const [name, expected] of EXPECTED_KEYS) {
    assert.equal(decodeFixture(name).key, expected, name);
  }
});

test('two spellings of one query collapse to one key', () => {
  assert.equal(
    decodeFixture('equality and inequality with two sorts').key,
    decodeFixture('the same query with its filters written in the other order').key,
  );
});

test('a collection group query is scoped as one', () => {
  const shape = decodeFixture('a collection group query');
  assert.equal(shape.collectionGroup, 'items');
  assert.equal(shape.queryScope, 'COLLECTION_GROUP');
});

test('a disjunction keeps its nesting rather than flattening into the conjunction', () => {
  const shape = decodeFixture('a disjunction nested under a conjunction');
  const nested = shape.where.filters.find((node) => 'filters' in node);
  assert.equal(nested.op, 'OR');
  // Both disjuncts are on `tier`; keeping the repeat is what stops a two-disjunct query from
  // being recorded as a one-disjunct query nobody issued.
  assert.deepEqual(nested.filters, [
    { fieldPath: 'tier', op: 'EQUAL' },
    { fieldPath: 'tier', op: 'EQUAL' },
  ]);
});

test('sort order is preserved as sent, not sorted', () => {
  const shape = decodeFixture('equality and inequality with two sorts');
  assert.deepEqual(shape.orderBy, [
    { fieldPath: 'amount', direction: 'DESCENDING' },
    { fieldPath: 'createdAt', direction: 'ASCENDING' },
  ]);
});

test('a query with no filters keeps an empty composite root', () => {
  const shape = decodeFixture('no filters and no sort');
  assert.deepEqual(shape.where, { op: 'AND', filters: [] });
  assert.deepEqual(shape.orderBy, []);
});

test('limit is not recorded', () => {
  // The fixture that carries `.limit(10)` and the one that does not key alike.
  assert.equal(
    decodeFixture('equality and inequality with two sorts').key,
    decodeFixture('the same query with its filters written in the other order').key,
  );
});

test('a request that carries no structured query is an unsupported shape', () => {
  const result = decodeRunQuery(Buffer.from([0x0a, 0x01, 0x78]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-shape');
});

test('bytes that are not a message are undecodable rather than a bad shape', () => {
  // Field 2, length-delimited, claiming more bytes than are present.
  const result = decodeRunQuery(Buffer.from([0x12, 0x7f, 0x01]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'undecodable-message');
});

test('a find_nearest clause is a vector query, not an unsupported shape', () => {
  // StructuredQuery{ from: [{collection_id: "o"}], find_nearest: {} } inside a RunQueryRequest.
  const query = Buffer.from([0x12, 0x03, 0x12, 0x01, 0x6f, 0x4a, 0x00]);
  const request = Buffer.concat([Buffer.from([0x12, query.length]), query]);
  const result = decodeRunQuery(request);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'vector-query');
});

test('an operator the vocabulary cannot name is skipped rather than invented', () => {
  // FieldFilter{ field: {field_path: "a"}, op: 99 } — a value no published enum defines.
  const filter = Buffer.from([0x0a, 0x03, 0x12, 0x01, 0x61, 0x10, 0x63]);
  const where = Buffer.concat([Buffer.from([0x12, filter.length]), filter]);
  const query = Buffer.concat([
    Buffer.from([0x12, 0x03, 0x12, 0x01, 0x6f]),
    Buffer.from([0x1a, where.length]),
    where,
  ]);
  const request = Buffer.concat([Buffer.from([0x12, query.length]), query]);
  const result = decodeRunQuery(request);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-shape');
});

test('an unset order direction is read as the documented default', () => {
  // Order{ field: {field_path: "a"} } with no direction: DIRECTION_UNSPECIFIED means ASCENDING.
  const order = Buffer.from([0x0a, 0x03, 0x12, 0x01, 0x61]);
  const query = Buffer.concat([
    Buffer.from([0x12, 0x03, 0x12, 0x01, 0x6f]),
    Buffer.from([0x22, order.length]),
    order,
  ]);
  const request = Buffer.concat([Buffer.from([0x12, query.length]), query]);
  const result = decodeRunQuery(request);
  assert.ok(result.ok);
  assert.deepEqual(result.query.orderBy, [{ fieldPath: 'a', direction: 'ASCENDING' }]);
});

test('a query that names more than one collection is skipped', () => {
  const query = Buffer.from([0x12, 0x03, 0x12, 0x01, 0x6f, 0x12, 0x03, 0x12, 0x01, 0x70]);
  const request = Buffer.concat([Buffer.from([0x12, query.length]), query]);
  const result = decodeRunQuery(request);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-shape');
});
