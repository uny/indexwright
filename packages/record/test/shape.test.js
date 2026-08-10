import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareByCodePoint,
  escapeComponent,
  normaliseFilter,
  normaliseRoot,
  queryKey,
  serialiseFilter,
  toQueryShape,
} from '../dist/index.js';

test('the key delimiters are escaped wherever they appear in a field path', () => {
  assert.equal(escapeComponent('a:b'), 'a\\:b');
  assert.equal(escapeComponent('a|b'), 'a\\|b');
  assert.equal(escapeComponent('f(x)'), 'f\\(x\\)');
  assert.equal(escapeComponent('a\\b'), 'a\\\\b');
  assert.equal(escapeComponent('plain.path'), 'plain.path');
});

test('control characters are escaped, so a key cannot forge a line of output', () => {
  assert.equal(escapeComponent('a\nb'), 'a\\u000ab');
  assert.equal(escapeComponent('a\u0000b'), 'a\\u0000b');
  assert.equal(escapeComponent('a\tb'), 'a\\u0009b');
});

test('escaping is what keeps the key injective', () => {
  // Unescaped, a single field named `a:EQUAL|b` would serialise exactly like two filters on `a`
  // and `b`, and the two queries would share one corpus entry.
  const collision = serialiseFilter({
    op: 'AND',
    filters: [{ fieldPath: 'a:EQUAL|b', op: 'EQUAL' }],
  });
  const distinct = serialiseFilter({
    op: 'AND',
    filters: [
      { fieldPath: 'a', op: 'EQUAL' },
      { fieldPath: 'b', op: 'EQUAL' },
    ],
  });
  assert.notEqual(collision, distinct);
});

test('comparison is by code point, not by UTF-16 code unit', () => {
  // U+1F600 is above U+FFFF, so a code-unit comparison puts it before U+FF21 and a code-point one
  // puts it after.
  assert.ok(compareByCodePoint('\u{1F600}', 'Ａ') > 0);
  assert.ok('\u{1F600}' < 'Ａ', 'the premise: `<` disagrees');
  assert.equal(compareByCodePoint('a', 'a'), 0);
  assert.ok(compareByCodePoint('a', 'ab') < 0);
});

test('a bare filter is wrapped in AND, and a composite root keeps its own operator', () => {
  assert.deepEqual(normaliseRoot({ fieldPath: 'a', op: 'EQUAL' }), {
    op: 'AND',
    filters: [{ fieldPath: 'a', op: 'EQUAL' }],
  });
  const or = { op: 'OR', filters: [{ fieldPath: 'a', op: 'EQUAL' }] };
  assert.deepEqual(normaliseRoot(or), or);
  assert.deepEqual(normaliseRoot(null), { op: 'AND', filters: [] });
});

test('a composite nested under the same operator is flattened, all the way down', () => {
  const nested = {
    op: 'AND',
    filters: [
      { fieldPath: 'a', op: 'EQUAL' },
      { op: 'AND', filters: [{ fieldPath: 'b', op: 'EQUAL' }, { op: 'AND', filters: [{ fieldPath: 'c', op: 'EQUAL' }] }] },
    ],
  };
  assert.equal(serialiseFilter(normaliseFilter(nested)), 'AND(a:EQUAL|b:EQUAL|c:EQUAL)');
});

test('a composite nested under a different operator is kept', () => {
  const mixed = {
    op: 'AND',
    filters: [
      { fieldPath: 'z', op: 'EQUAL' },
      { op: 'OR', filters: [{ fieldPath: 'a', op: 'EQUAL' }, { fieldPath: 'b', op: 'EQUAL' }] },
    ],
  };
  assert.equal(serialiseFilter(normaliseFilter(mixed)), 'AND(OR(a:EQUAL|b:EQUAL)|z:EQUAL)');
});

test('children are sorted, so the order the filters were written in does not reach the key', () => {
  const one = normaliseRoot({
    op: 'AND',
    filters: [{ fieldPath: 'b', op: 'EQUAL' }, { fieldPath: 'a', op: 'EQUAL' }],
  });
  const other = normaliseRoot({
    op: 'AND',
    filters: [{ fieldPath: 'a', op: 'EQUAL' }, { fieldPath: 'b', op: 'EQUAL' }],
  });
  assert.equal(serialiseFilter(one), serialiseFilter(other));
});

test('repeated children survive normalisation', () => {
  const repeated = normaliseRoot({
    op: 'OR',
    filters: [{ fieldPath: 'tier', op: 'EQUAL' }, { fieldPath: 'tier', op: 'EQUAL' }],
  });
  assert.equal(serialiseFilter(repeated), 'OR(tier:EQUAL|tier:EQUAL)');
});

test('sort order is not commutative and is left as sent', () => {
  const shape = toQueryShape({
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    where: null,
    orderBy: [
      { fieldPath: 'b', direction: 'ASCENDING' },
      { fieldPath: 'a', direction: 'DESCENDING' },
    ],
  });
  assert.equal(shape.key, 'orders::COLLECTION::AND()::b:ASCENDING|a:DESCENDING');
});

test('the key is derived from the shape it sits on', () => {
  const shape = toQueryShape({
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    where: { fieldPath: 'status', op: 'EQUAL' },
    orderBy: [],
  });
  assert.equal(shape.key, queryKey(shape));
  assert.equal(shape.key, 'orders::COLLECTION::AND(status:EQUAL)::');
});

test('a collection id holding a delimiter cannot be confused with the separators', () => {
  const shape = toQueryShape({
    collectionGroup: 'a::b',
    queryScope: 'COLLECTION',
    where: null,
    orderBy: [],
  });
  assert.equal(shape.key, 'a\\:\\:b::COLLECTION::AND()::');
});
