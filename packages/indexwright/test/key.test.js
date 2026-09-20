import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyse,
  analyseOverrides,
  canonicalFields,
  canonicalSingleFieldIndexes,
  implicitNameDirection,
  indexKey,
  overrideKey,
} from '../dist/index.js';

test('the implicit __name__ direction follows the last ordered field', () => {
  assert.equal(
    implicitNameDirection([
      { fieldPath: 'type', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
    ]),
    'DESCENDING',
  );
  assert.equal(
    implicitNameDirection([
      { fieldPath: 'public', order: 'ASCENDING' },
      { fieldPath: 'startAt', order: 'ASCENDING' },
    ]),
    'ASCENDING',
  );
});

test('the implicit __name__ direction is ASCENDING when the index ends with an array field', () => {
  assert.equal(
    implicitNameDirection([
      { fieldPath: 'isRecommended', order: 'ASCENDING' },
      { fieldPath: 'tags', arrayConfig: 'CONTAINS' },
    ]),
    'ASCENDING',
  );
  assert.equal(implicitNameDirection([]), 'ASCENDING');
});

test('a trailing __name__ matching the default is stripped', () => {
  const result = canonicalFields([
    { fieldPath: 'type', order: 'ASCENDING' },
    { fieldPath: 'createdAt', order: 'DESCENDING' },
    { fieldPath: '__name__', order: 'DESCENDING' },
  ]);
  assert.deepEqual(
    result.fields.map((field) => field.fieldPath),
    ['type', 'createdAt'],
  );
  assert.equal(result.redundantNameDirection, 'DESCENDING');
});

test('a trailing __name__ with a non-default direction is kept', () => {
  const result = canonicalFields([
    { fieldPath: 'totalNbUses', order: 'DESCENDING' },
    { fieldPath: '__name__', order: 'ASCENDING' },
  ]);
  assert.deepEqual(
    result.fields.map((field) => field.fieldPath),
    ['totalNbUses', '__name__'],
  );
  assert.equal(result.redundantNameDirection, null);
});

test('a __name__ that is not last is kept', () => {
  const result = canonicalFields([
    { fieldPath: '__name__', order: 'ASCENDING' },
    { fieldPath: 'createdAt', order: 'ASCENDING' },
  ]);
  assert.equal(result.fields.length, 2);
  assert.equal(result.redundantNameDirection, null);
});

test('the canonical key separates collectionGroup, queryScope, and fields', () => {
  assert.equal(
    indexKey('posts', 'COLLECTION', [
      { fieldPath: 'authorId', direction: 'ASCENDING' },
      { fieldPath: 'createdAt', direction: 'DESCENDING' },
    ]),
    'posts::COLLECTION::authorId:ASCENDING|createdAt:DESCENDING',
  );
});

test('two spellings of one index produce one key', () => {
  const [withName, withoutName] = analyse({
    indexes: [
      {
        collectionGroup: 'posts',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'authorId', order: 'ASCENDING' },
          { fieldPath: '__name__', order: 'ASCENDING' },
        ],
      },
      {
        collectionGroup: 'posts',
        queryScope: 'COLLECTION',
        fields: [{ fieldPath: 'authorId', order: 'ASCENDING' }],
      },
    ],
  });
  assert.equal(withName.key, withoutName.key);
});

test('a vector field carries its dimension into the key', () => {
  const [index] = analyse({
    indexes: [
      {
        collectionGroup: 'articles',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'locale', order: 'ASCENDING' },
          { fieldPath: 'embedding', vectorConfig: { dimension: 768, flat: {} } },
        ],
      },
    ],
  });
  assert.equal(index.key, 'articles::COLLECTION::locale:ASCENDING|embedding:VECTOR(768)');
});

test('an absent fieldOverrides analyses as no overrides', () => {
  assert.deepEqual(analyseOverrides({ indexes: [] }), []);
  assert.deepEqual(analyseOverrides({ indexes: [], fieldOverrides: [] }), []);
});

test('an override key is the collection group, the field path, and the declared set', () => {
  const [override] = analyseOverrides({
    indexes: [],
    fieldOverrides: [
      {
        collectionGroup: 'posts',
        fieldPath: 'tags',
        indexes: [
          { queryScope: 'COLLECTION', order: 'ASCENDING' },
          { queryScope: 'COLLECTION', order: 'DESCENDING' },
          { queryScope: 'COLLECTION', arrayConfig: 'CONTAINS' },
          { queryScope: 'COLLECTION_GROUP', arrayConfig: 'CONTAINS' },
        ],
      },
    ],
  });
  assert.equal(override.position, 0);
  assert.equal(override.collectionGroup, 'posts');
  assert.equal(override.fieldPath, 'tags');
  assert.equal(
    override.key,
    'posts::tags::COLLECTION:ASCENDING|COLLECTION:CONTAINS|COLLECTION:DESCENDING|COLLECTION_GROUP:CONTAINS',
  );
  assert.equal(override.key, overrideKey('posts', 'tags', override.indexes));
});

test('the declared set is canonicalised as a set: order-independent, and an exact repeat collapsed', () => {
  const canonical = canonicalSingleFieldIndexes([
    { queryScope: 'COLLECTION_GROUP', order: 'ASCENDING' },
    { queryScope: 'COLLECTION', order: 'DESCENDING' },
    { queryScope: 'COLLECTION', order: 'ASCENDING' },
    { queryScope: 'COLLECTION', order: 'DESCENDING' },
  ]);
  assert.deepEqual(canonical, [
    { queryScope: 'COLLECTION', direction: 'ASCENDING' },
    { queryScope: 'COLLECTION', direction: 'DESCENDING' },
    { queryScope: 'COLLECTION_GROUP', direction: 'ASCENDING' },
  ]);
  // Two configurations differing in one member never meet.
  assert.notEqual(
    overrideKey('a', 'x', canonicalSingleFieldIndexes([{ queryScope: 'COLLECTION', order: 'ASCENDING' }])),
    overrideKey('a', 'x', canonicalSingleFieldIndexes([{ queryScope: 'COLLECTION_GROUP', order: 'ASCENDING' }])),
  );
});

test('an exemption keys with an empty set, and a vector single-field index carries its dimension', () => {
  const [exemption, vector] = analyseOverrides({
    indexes: [],
    fieldOverrides: [
      { collectionGroup: 'logs', fieldPath: 'payload', indexes: [] },
      {
        collectionGroup: 'articles',
        fieldPath: 'embedding',
        indexes: [{ queryScope: 'COLLECTION', vectorConfig: { dimension: 768, flat: {} } }],
      },
    ],
  });
  assert.equal(exemption.key, 'logs::payload::');
  assert.deepEqual(exemption.indexes, []);
  assert.equal(vector.position, 1);
  assert.equal(vector.key, 'articles::embedding::COLLECTION:VECTOR(768)');
});

test('ttl and unknown keys are carried on the source and are not part of the key', () => {
  const [withTtl, without] = analyseOverrides({
    indexes: [],
    fieldOverrides: [
      { collectionGroup: 'a', fieldPath: 'x', ttl: true, indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }] },
      { collectionGroup: 'a', fieldPath: 'x', indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }] },
    ],
  });
  assert.equal(withTtl.key, without.key);
  assert.equal(withTtl.source.ttl, true);
});
