import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, canonicalFields, implicitNameDirection, indexKey } from '../dist/index.js';

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
