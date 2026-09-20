import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MalformedInputError, parseDocument } from '../dist/index.js';

function rejects(text, fragment) {
  assert.throws(
    () => parseDocument(text),
    (error) => {
      assert.ok(error instanceof MalformedInputError, `expected MalformedInputError, got ${error}`);
      assert.match(error.message, fragment);
      return true;
    },
  );
}

test('invalid JSON is malformed, and the message stays on one line', () => {
  rejects('{ "indexes": [ }', /invalid JSON/);
  rejects('{\n  "indexes": [ }\n', /^[^\n]+$/);
});

test('a non-object top level is malformed', () => {
  rejects('[]', /top level must be a JSON object/);
});

test('a missing or non-array "indexes" is malformed', () => {
  rejects('{}', /missing "indexes"/);
  rejects('{ "indexes": {} }', /"indexes" must be an array/);
});

test('an index without collectionGroup, queryScope, or fields is malformed', () => {
  rejects('{ "indexes": [{ "queryScope": "COLLECTION", "fields": [] }] }', /"collectionGroup" is missing/);
  rejects('{ "indexes": [{ "collectionGroup": "a", "fields": [] }] }', /"queryScope" is missing/);
  rejects('{ "indexes": [{ "collectionGroup": "a", "queryScope": "COLLECTION" }] }', /"fields" must be an array/);
  rejects(
    '{ "indexes": [{ "collectionGroup": "a", "queryScope": "COLLECTION", "fields": [] }] }',
    /"fields" must not be empty/,
  );
});

test('a field needs exactly one of order, arrayConfig, and vectorConfig', () => {
  const withFields = (fields) =>
    `{ "indexes": [{ "collectionGroup": "a", "queryScope": "COLLECTION", "fields": ${fields} }] }`;
  rejects(withFields('[{ "fieldPath": "x" }]'), /needs one of "order", "arrayConfig", or "vectorConfig"/);
  rejects(
    withFields('[{ "fieldPath": "x", "order": "ASCENDING", "arrayConfig": "CONTAINS" }]'),
    /only one is allowed/,
  );
  rejects(withFields('[{ "order": "ASCENDING" }]'), /"fieldPath" is missing/);
});

test('a repeated fieldPath is carried through rather than rejected', () => {
  // Refusing the file would cost the reader every other index in it, and this shape occurs in
  // live exports.
  const document = parseDocument(
    '{ "indexes": [{ "collectionGroup": "a", "queryScope": "COLLECTION", "fields": [' +
      '{ "fieldPath": "x", "order": "ASCENDING" }, { "fieldPath": "x", "order": "DESCENDING" }] }] }',
  );
  assert.equal(document.indexes[0].fields.length, 2);
});

test('the error path points at the offending entry', () => {
  rejects(
    '{ "indexes": [{ "collectionGroup": "a", "queryScope": "COLLECTION", "fields": [' +
      '{ "fieldPath": "x", "order": "ASCENDING" }, { "fieldPath": "y" }] }] }',
    /^indexes\[0\]\.fields\[1\]:/,
  );
});

test('unknown keys and unknown enum values pass through', () => {
  const document = parseDocument(
    '{ "indexes": [{ "collectionGroup": "a", "queryScope": "SOMETHING_NEW", "density": "SPARSE_ALL",' +
      ' "fields": [{ "fieldPath": "x", "order": "SOMETHING_NEW", "extra": 1 }] }], "extra": {} }',
  );
  assert.equal(document.indexes[0].density, 'SPARSE_ALL');
  assert.equal(document.indexes[0].queryScope, 'SOMETHING_NEW');
  assert.equal(document.indexes[0].fields[0].extra, 1);
  assert.deepEqual(document.extra, {});
});

test('an absent "fieldOverrides" is left absent, and a present one must be an array', () => {
  const document = parseDocument('{ "indexes": [] }');
  assert.equal('fieldOverrides' in document, false);
  rejects('{ "indexes": [], "fieldOverrides": {} }', /"fieldOverrides" must be an array/);
});

test('a field override needs collectionGroup, fieldPath, and an indexes array', () => {
  rejects(
    '{ "indexes": [], "fieldOverrides": [{ "fieldPath": "x", "indexes": [] }] }',
    /^fieldOverrides\[0\]: "collectionGroup" is missing/,
  );
  rejects(
    '{ "indexes": [], "fieldOverrides": [{ "collectionGroup": "a", "indexes": [] }] }',
    /^fieldOverrides\[0\]: "fieldPath" is missing/,
  );
  rejects(
    '{ "indexes": [], "fieldOverrides": [{ "collectionGroup": "a", "fieldPath": "x" }] }',
    /^fieldOverrides\[0\]: "indexes" must be an array/,
  );
  rejects('{ "indexes": [], "fieldOverrides": [1] }', /^fieldOverrides\[0\]: must be an object/);
});

test('an override declaring no indexes is an exemption, not an error', () => {
  const document = parseDocument(
    '{ "indexes": [], "fieldOverrides": [{ "collectionGroup": "a", "fieldPath": "x", "indexes": [] }] }',
  );
  assert.deepEqual(document.fieldOverrides[0].indexes, []);
});

test('a single-field index needs a queryScope and exactly one config, like a composite field', () => {
  const withIndexes = (indexes) =>
    `{ "indexes": [], "fieldOverrides": [{ "collectionGroup": "a", "fieldPath": "x", "indexes": ${indexes} }] }`;
  rejects(withIndexes('[{ "order": "ASCENDING" }]'), /^fieldOverrides\[0\]\.indexes\[0\]: "queryScope" is missing/);
  rejects(
    withIndexes('[{ "queryScope": "COLLECTION" }]'),
    /^fieldOverrides\[0\]\.indexes\[0\]: needs one of "order", "arrayConfig", or "vectorConfig"/,
  );
  rejects(
    withIndexes('[{ "queryScope": "COLLECTION", "order": "ASCENDING", "arrayConfig": "CONTAINS" }]'),
    /^fieldOverrides\[0\]\.indexes\[0\]: declares "order" and "arrayConfig"; only one is allowed/,
  );
  rejects(
    withIndexes('[{ "queryScope": "COLLECTION", "vectorConfig": 4 }]'),
    /^fieldOverrides\[0\]\.indexes\[0\]: "vectorConfig" must be an object/,
  );
  rejects(withIndexes('[null]'), /^fieldOverrides\[0\]\.indexes\[0\]: must be an object/);
});

test('"ttl" is checked for type only, and unknown keys on an override pass through', () => {
  rejects(
    '{ "indexes": [], "fieldOverrides": [{ "collectionGroup": "a", "fieldPath": "x", "indexes": [], "ttl": "yes" }] }',
    /^fieldOverrides\[0\]: "ttl" must be a boolean/,
  );
  const document = parseDocument(
    '{ "indexes": [], "fieldOverrides": [{ "collectionGroup": "a", "fieldPath": "x", "ttl": true, "extra": 1,' +
      ' "indexes": [{ "queryScope": "SOMETHING_NEW", "order": "ASCENDING", "density": "DENSE" }] }] }',
  );
  const [override] = document.fieldOverrides;
  assert.equal(override.ttl, true);
  assert.equal(override.extra, 1);
  assert.equal(override.indexes[0].queryScope, 'SOMETHING_NEW');
  assert.equal(override.indexes[0].density, 'DENSE');
});
