import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decodeJsonListen,
  decodeJsonRunQuery,
  forwardChannelMessages,
  toQueryShape,
  WireError,
} from '../dist/index.js';

/**
 * Real request bodies, as the Firebase Web SDK sends them: a WebChannel forward-channel POST from
 * the browser build, and a REST `documents:runQuery` from `firebase/firestore/lite`.
 *
 * The expected keys below are written by hand rather than generated, so that the assertion is
 * about what the wire means and not about what this decoder currently does with it. They differ
 * from `decode.test.js`'s keys for the same queries where the Web SDK normalises before sending
 * (SPEC §7, *Implicit fields are not materialised*): it appends `__name__` to every sort order and
 * promotes an inequality field into it, and the corpus records what was sent. Regenerate the bodies
 * with `scripts/capture-web-fixtures.mjs`.
 */
const { cases } = JSON.parse(
  readFileSync(fileURLToPath(new URL('fixtures/web-sdk.json', import.meta.url)), 'utf8'),
);

const EXPECTED_KEYS = new Map([
  [
    'equality and inequality with two sorts',
    'orders::COLLECTION::AND(amount:GREATER_THAN|status:EQUAL)::' +
      'amount:DESCENDING|createdAt:ASCENDING|__name__:ASCENDING',
  ],
  ['a collection group query', 'items::COLLECTION_GROUP::AND(sku:EQUAL)::qty:ASCENDING|__name__:ASCENDING'],
  ['no filters and no sort', 'orders::COLLECTION::AND()::__name__:ASCENDING'],
  [
    'a disjunction nested under a conjunction',
    'orders::COLLECTION::AND(OR(tier:EQUAL|tier:EQUAL)|tags:ARRAY_CONTAINS)::__name__:ASCENDING',
  ],
  [
    'every field operator',
    'orders::COLLECTION::AND(a:LESS_THAN|b:LESS_THAN_OR_EQUAL|c:GREATER_THAN|' +
      'd:GREATER_THAN_OR_EQUAL|e:EQUAL|f:ARRAY_CONTAINS|g:IN|h:ARRAY_CONTAINS_ANY)::' +
      'a:ASCENDING|b:ASCENDING|c:ASCENDING|d:ASCENDING|__name__:ASCENDING',
  ],
  ['a not-equal filter', 'orders::COLLECTION::AND(state:NOT_EQUAL)::state:ASCENDING|__name__:ASCENDING'],
  ['a not-in filter', 'orders::COLLECTION::AND(state:NOT_IN)::state:ASCENDING|__name__:ASCENDING'],
  [
    'null and NaN, which reach the wire as unary filters',
    'orders::COLLECTION::AND(deletedAt:IS_NULL|score:IS_NAN)::__name__:ASCENDING',
  ],
  ['not-null', 'orders::COLLECTION::AND(deletedAt:IS_NOT_NULL)::deletedAt:ASCENDING|__name__:ASCENDING'],
  ['not-NaN', 'orders::COLLECTION::AND(score:IS_NOT_NAN)::score:ASCENDING|__name__:ASCENDING'],
  ['a sort on the document key', 'orders::COLLECTION::AND()::__name__:DESCENDING'],
  [
    // The Web SDK backtick-quotes a path that needs it; the server SDK sends it bare. Recorded as
    // sent, which is the same rule as the sort order.
    'a field path that holds the key delimiters',
    'orders::COLLECTION::AND(`weird\\:path\\|with\\(parens\\)`:EQUAL)::__name__:ASCENDING',
  ],
  ['a nested field path', 'orders::COLLECTION::AND(profile.city:EQUAL)::__name__:ASCENDING'],
]);

function fixture(name) {
  const found = cases.find((entry) => entry.name === name);
  assert.ok(found, `fixture "${name}" is missing; regenerate scripts/capture-web-fixtures.mjs`);
  return found;
}

function decodeForwardChannel(name) {
  const messages = forwardChannelMessages(Buffer.from(fixture(name).forwardChannel.body, 'utf8'));
  assert.equal(messages.length, 1, `expected one message on the forward channel for "${name}"`);
  const result = decodeJsonListen(messages[0]);
  assert.ok(result?.ok, `expected "${name}" to decode, got ${result === null ? 'null' : result.reason}`);
  return toQueryShape(result.query);
}

function decodeRest(name) {
  const result = decodeJsonRunQuery(Buffer.from(fixture(name).rest.body, 'utf8'));
  assert.ok(result.ok, `expected "${name}" to decode, got ${result.ok ? '' : result.reason}`);
  return toQueryShape(result.query);
}

test('every captured forward-channel message decodes to the shape it was written as', () => {
  assert.equal(cases.length, EXPECTED_KEYS.size, 'the fixture and the expectations disagree in size');
  for (const [name, expected] of EXPECTED_KEYS) {
    assert.equal(decodeForwardChannel(name).key, expected, name);
  }
});

test('every captured REST request decodes to the same shape as its forward-channel twin', () => {
  // One application query, two transports, one corpus entry: the transport is not part of a shape.
  for (const [name, expected] of EXPECTED_KEYS) {
    assert.equal(decodeRest(name).key, expected, name);
  }
});

test('the fixtures were captured with the bodies the Web SDK really sends', () => {
  // Content types are recorded so that a regeneration against a client that changed transport is
  // noticed here rather than in a proxy that classifies by path.
  for (const entry of cases) {
    assert.equal(entry.forwardChannel.contentType, 'application/x-www-form-urlencoded', entry.name);
    assert.equal(entry.rest.contentType, 'text/plain', entry.name);
    assert.match(entry.rest.path, /\/documents:runQuery$/, entry.name);
  }
});

test('a forward channel carries its messages in request order, whatever order the form lists them', () => {
  const first = JSON.stringify({ database: 'd', addTarget: { query: { structuredQuery: { from: [{ collectionId: 'a' }] } } } });
  const second = JSON.stringify({ database: 'd', removeTarget: 2 });
  const body = new URLSearchParams({ count: '2', ofs: '0', req1___data__: second, req0___data__: first });
  assert.deepEqual(forwardChannelMessages(Buffer.from(body.toString(), 'utf8')), [first, second]);
});

test("a forward channel's handshake and headers carry no message", () => {
  const body = 'headers=X-Goog-Api-Client%3Agl-js%0D%0A&count=0&ofs=0';
  assert.deepEqual(forwardChannelMessages(Buffer.from(body, 'utf8')), []);
  assert.deepEqual(forwardChannelMessages(Buffer.alloc(0)), []);
});

test('a forward channel that is not UTF-8 is a wire error, which the recorder counts as undecodable', () => {
  assert.throws(() => forwardChannelMessages(Buffer.from([0xff, 0xfe])), WireError);
});

test('the original proto field names read as the same query the lowerCamelCase ones do', () => {
  // Not a fixture: no Firebase SDK writes this spelling, and the fixtures hold what a client sent.
  // A conforming proto3 JSON writer may, though, and the proxy reads the wire rather than the
  // source. Written out in full so that a field read under only one spelling fails here — three of
  // them (`all_descendants`, `order_by`, `find_nearest`) used to fall through as unknown keys and
  // record the query under the wrong shape rather than decline it.
  const camel = {
    structuredQuery: {
      from: [{ collectionId: 'items', allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'sku' }, op: 'EQUAL' } },
            { unaryFilter: { field: { fieldPath: 'deletedAt' }, op: 'IS_NULL' } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: 'qty' }, direction: 'DESCENDING' }],
    },
  };
  const snake = {
    structured_query: {
      from: [{ collection_id: 'items', all_descendants: true }],
      where: {
        composite_filter: {
          op: 'AND',
          filters: [
            { field_filter: { field: { field_path: 'sku' }, op: 'EQUAL' } },
            { unary_filter: { field: { field_path: 'deletedAt' }, op: 'IS_NULL' } },
          ],
        },
      },
      order_by: [{ field: { field_path: 'qty' }, direction: 'DESCENDING' }],
    },
  };
  const read = (body) => decodeJsonRunQuery(Buffer.from(JSON.stringify(body), 'utf8'));
  // Conjuncts sorted, as `toQueryShape` sorts them; the sort order is not.
  const expected = 'items::COLLECTION_GROUP::AND(deletedAt:IS_NULL|sku:EQUAL)::qty:DESCENDING';
  assert.equal(toQueryShape(read(camel).query).key, expected);
  assert.equal(toQueryShape(read(snake).query).key, expected);
});

test('a find_nearest under either spelling is a vector query, not a shape recorded without it', () => {
  const vector = { vectorField: { fieldPath: 'embedding' }, limit: 5 };
  for (const query of [{ findNearest: vector }, { find_nearest: vector }]) {
    const body = { structuredQuery: { from: [{ collectionId: 'docs' }], ...query } };
    assert.deepEqual(decodeJsonRunQuery(Buffer.from(JSON.stringify(body), 'utf8')), {
      ok: false,
      reason: 'vector-query',
    });
  }
});

test('a field named under both spellings at once is undecodable, because neither one wins', () => {
  const body = { structuredQuery: { from: [{ collectionId: 'i', allDescendants: true, all_descendants: false }] } };
  assert.deepEqual(decodeJsonRunQuery(Buffer.from(JSON.stringify(body), 'utf8')), {
    ok: false,
    reason: 'undecodable-message',
  });
});

test('a forward channel that declares more messages than it carries is a wire error', () => {
  // The framing tripwire: a body whose `reqN___data__` keys this reader no longer recognises yields
  // nothing, and without this it would leave neither a shape nor a skip behind.
  assert.throws(() => forwardChannelMessages(Buffer.from('count=1&ofs=0', 'utf8')), WireError);
  assert.throws(
    () => forwardChannelMessages(Buffer.from('count=2&ofs=0&req0___data__=%7B%7D', 'utf8')),
    WireError,
  );
  assert.throws(() => forwardChannelMessages(Buffer.from('count=one&ofs=0', 'utf8')), WireError);
  // A body with no `count` at all is still read for what it carries; only a stated one is held.
  assert.deepEqual(forwardChannelMessages(Buffer.from('req0___data__=%7B%7D', 'utf8')), ['{}']);
});

test('a remove_target and a documents target carry no query and decode to nothing', () => {
  assert.equal(decodeJsonListen(JSON.stringify({ database: 'd', removeTarget: 1002 })), null);
  assert.equal(
    decodeJsonListen(JSON.stringify({ database: 'd', addTarget: { documents: { documents: ['a/b'] }, targetId: 4 } })),
    null,
  );
});

test('a query target with no structured query is an unsupported shape', () => {
  const result = decodeJsonListen(JSON.stringify({ addTarget: { query: { parent: 'p' } } }));
  assert.deepEqual(result, { ok: false, reason: 'unsupported-shape' });
});

test('a request that is not JSON, or not an object, is undecodable rather than a bad shape', () => {
  assert.deepEqual(decodeJsonRunQuery(Buffer.from('{"structuredQuery":', 'utf8')), { ok: false, reason: 'undecodable-message' });
  assert.deepEqual(decodeJsonRunQuery(Buffer.from('[]', 'utf8')), { ok: false, reason: 'undecodable-message' });
  assert.deepEqual(decodeJsonRunQuery(Buffer.from([0xff]) ), { ok: false, reason: 'undecodable-message' });
  assert.deepEqual(decodeJsonListen('null'), { ok: false, reason: 'undecodable-message' });
});

test('a value of the wrong type under a known key is undecodable, not read around', () => {
  const bad = (structuredQuery) => decodeJsonRunQuery(Buffer.from(JSON.stringify({ structuredQuery }), 'utf8'));
  assert.deepEqual(bad({ from: [{ collectionId: 7 }] }), { ok: false, reason: 'undecodable-message' });
  assert.deepEqual(bad({ from: [{ collectionId: 'a', allDescendants: 'yes' }] }), { ok: false, reason: 'undecodable-message' });
  assert.deepEqual(bad({ from: 'orders' }), { ok: false, reason: 'undecodable-message' });
  assert.deepEqual(bad({ from: [{ collectionId: 'a' }], where: { fieldFilter: { field: 'x', op: 'EQUAL' } } }), {
    ok: false,
    reason: 'undecodable-message',
  });
  assert.deepEqual(bad({ from: [{ collectionId: 'a' }], orderBy: [{ field: { fieldPath: 'x' }, direction: 2 }] }), {
    ok: false,
    reason: 'undecodable-message',
  });
});

test('a request that carries no structured query is an unsupported shape', () => {
  assert.deepEqual(decodeJsonRunQuery(Buffer.from('{"parent":"p"}', 'utf8')), { ok: false, reason: 'unsupported-shape' });
});

test('a findNearest clause is a vector query, not an unsupported shape', () => {
  const result = decodeJsonRunQuery(
    Buffer.from(JSON.stringify({ structuredQuery: { from: [{ collectionId: 'o' }], findNearest: {} } }), 'utf8'),
  );
  assert.deepEqual(result, { ok: false, reason: 'vector-query' });
});

test('an operator the vocabulary cannot name is skipped rather than invented', () => {
  const query = (where) => decodeJsonRunQuery(Buffer.from(JSON.stringify({ structuredQuery: { from: [{ collectionId: 'o' }], where } }), 'utf8'));
  assert.deepEqual(query({ fieldFilter: { field: { fieldPath: 'a' }, op: 'OPERATOR_UNSPECIFIED' } }), { ok: false, reason: 'unsupported-shape' });
  assert.deepEqual(query({ fieldFilter: { field: { fieldPath: 'a' }, op: 'IS_NULL' } }), { ok: false, reason: 'unsupported-shape' });
  assert.deepEqual(query({ unaryFilter: { field: { fieldPath: 'a' }, op: 'EQUAL' } }), { ok: false, reason: 'unsupported-shape' });
  assert.deepEqual(query({ compositeFilter: { op: 'XOR', filters: [] } }), { ok: false, reason: 'unsupported-shape' });
  assert.deepEqual(query({ somethingNew: {} }), { ok: false, reason: 'unsupported-shape' });
});

test('a from that does not name exactly one collection is an unsupported shape', () => {
  const query = (from) => decodeJsonRunQuery(Buffer.from(JSON.stringify({ structuredQuery: { from } }), 'utf8'));
  assert.deepEqual(query(undefined), { ok: false, reason: 'unsupported-shape' });
  assert.deepEqual(query([]), { ok: false, reason: 'unsupported-shape' });
  assert.deepEqual(query([{ collectionId: 'a' }, { collectionId: 'b' }]), { ok: false, reason: 'unsupported-shape' });
  assert.deepEqual(query([{}]), { ok: false, reason: 'unsupported-shape' });
  assert.deepEqual(query([{ collectionId: '' }]), { ok: false, reason: 'unsupported-shape' });
});

test('a sort with no direction, or an unspecified one, is ascending as Firestore documents it', () => {
  const orderBy = [{ field: { fieldPath: 'a' } }, { field: { fieldPath: 'b' }, direction: 'DIRECTION_UNSPECIFIED' }];
  const result = decodeJsonRunQuery(Buffer.from(JSON.stringify({ structuredQuery: { from: [{ collectionId: 'o' }], orderBy } }), 'utf8'));
  assert.ok(result.ok);
  assert.deepEqual(result.query.orderBy, [
    { fieldPath: 'a', direction: 'ASCENDING' },
    { fieldPath: 'b', direction: 'ASCENDING' },
  ]);
});

test('a sort direction with no published meaning is an unsupported shape', () => {
  const orderBy = [{ field: { fieldPath: 'a' }, direction: 'SIDEWAYS' }];
  const result = decodeJsonRunQuery(Buffer.from(JSON.stringify({ structuredQuery: { from: [{ collectionId: 'o' }], orderBy } }), 'utf8'));
  assert.deepEqual(result, { ok: false, reason: 'unsupported-shape' });
});

test('a filter tree deeper than the reader descends is declined rather than overflowing the stack', () => {
  let where = { fieldFilter: { field: { fieldPath: 'a' }, op: 'EQUAL' } };
  for (let depth = 0; depth < 200; depth += 1) where = { compositeFilter: { op: 'AND', filters: [where] } };
  const result = decodeJsonRunQuery(Buffer.from(JSON.stringify({ structuredQuery: { from: [{ collectionId: 'o' }], where } }), 'utf8'));
  assert.deepEqual(result, { ok: false, reason: 'unsupported-shape' });
});

test('keys this reader does not expect are ignored, as protobuf ignores an unknown field', () => {
  const structuredQuery = {
    from: [{ collectionId: 'o' }],
    select: { fields: [{ fieldPath: 'a' }] },
    limit: 3,
    offset: 1,
    startAt: { values: [] },
    somethingNew: true,
  };
  const result = decodeJsonRunQuery(Buffer.from(JSON.stringify({ structuredQuery, parent: 'p', newTransaction: {} }), 'utf8'));
  assert.ok(result.ok);
  assert.equal(toQueryShape(result.query).key, 'o::COLLECTION::AND()::');
});
