import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeRunQuery, toQueryShape } from '../dist/index.js';
import * as wire from '../dist/wire.js';

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

test('a filter tree nested past what the reader descends is skipped, not a crash', () => {
  // The reader recurses once per level, so the bytes choose the stack depth. A body far under the
  // proxy's size cap can reach `RangeError`, which is not a `WireError` and would leave
  // `decodeRunQuery` as an uncaught exception rather than a counted skip.
  const varint = (value) => {
    const out = [];
    let rest = value;
    do {
      const byte = rest & 0x7f;
      rest >>>= 7;
      out.push(rest > 0 ? byte | 0x80 : byte);
    } while (rest > 0);
    return Buffer.from(out);
  };
  const delimited = (field, payload) =>
    Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);

  // Filter{ field_filter: FieldFilter{ field: {field_path: "a"}, op: EQUAL } }
  const leaf = delimited(2, Buffer.concat([delimited(1, delimited(2, Buffer.from('a'))), Buffer.from([0x10, 0x05])]));
  const nest = (depth) => {
    let filter = leaf;
    for (let level = 0; level < depth; level += 1) {
      filter = delimited(1, Buffer.concat([Buffer.from([0x08, 0x01]), delimited(2, filter)]));
    }
    const query = Buffer.concat([delimited(2, delimited(2, Buffer.from('orders'))), delimited(3, filter)]);
    return delimited(2, query);
  };

  const shallow = decodeRunQuery(nest(50));
  assert.ok(shallow.ok);

  const deep = decodeRunQuery(nest(20000));
  assert.equal(deep.ok, false);
  assert.equal(deep.reason, 'unsupported-shape');
});

test('a negative enum value is an unsupported shape, not a misread message', () => {
  // FieldFilter{ field: {field_path: "a"}, op: -1 } — proto3 sign-extends a negative enum to the
  // full ten bytes. Read as unsigned it is a huge number, and reporting it as
  // `undecodable-message` would claim this decoder read the wire wrongly for a message that
  // parsed perfectly and merely carried an operator the vocabulary cannot name.
  const filter = Buffer.from([
    0x0a, 0x03, 0x12, 0x01, 0x61, 0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
  ]);
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

test('a varint that does not fit in 64 bits is refused rather than folded', () => {
  // Ten bytes is the maximum length, but the tenth may only carry bit 63. Accepting more lets a
  // value above 2^64 wrap into the range of a real operator, and the corpus would then assert a
  // query shape nobody issued.
  const { fields, WireError } = wire;
  const tooWide = Uint8Array.from([0x10, 0x85, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02]);
  assert.throws(() => [...fields(tooWide)], WireError);

  // A negative int32 is sign-extended to ten bytes and is still a legal varint.
  const negative = Uint8Array.from([0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
  assert.equal([...fields(negative)].length, 1);
});
