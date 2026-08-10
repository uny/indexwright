import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildCorpus,
  CORPUS_VERSION,
  CorpusError,
  parseCorpus,
  serialiseCorpus,
  toQueryShape,
  writeCorpus,
} from '../dist/index.js';

const shape = (collectionGroup, where = null, orderBy = []) =>
  toQueryShape({ collectionGroup, queryScope: 'COLLECTION', where, orderBy });

test('entries are de-duplicated by key and sorted by it', () => {
  const corpus = buildCorpus([shape('z'), shape('a'), shape('z')], []);
  assert.deepEqual(
    corpus.queries.map((query) => query.collectionGroup),
    ['a', 'z'],
  );
});

test('skip reasons are a sorted set', () => {
  const corpus = buildCorpus([], ['listen-query', 'aggregation-query', 'listen-query']);
  assert.deepEqual(corpus.skipped, ['aggregation-query', 'listen-query']);
});

test('every member is present even when there is nothing to say', () => {
  const document = JSON.parse(serialiseCorpus(buildCorpus([], [])));
  assert.deepEqual(document, { corpusVersion: CORPUS_VERSION, queries: [], skipped: [] });
});

test('the serialised members are in the documented order', () => {
  const text = serialiseCorpus(buildCorpus([shape('orders', { fieldPath: 'a', op: 'EQUAL' })], []));
  const entry = JSON.parse(text).queries[0];
  assert.deepEqual(Object.keys(entry), ['key', 'collectionGroup', 'queryScope', 'where', 'orderBy']);
  assert.deepEqual(Object.keys(entry.where), ['op', 'filters']);
  assert.deepEqual(Object.keys(entry.where.filters[0]), ['fieldPath', 'op']);
  assert.ok(text.endsWith('\n'));
});

test('two recorders that saw the same query in different spellings write the same bytes', () => {
  const one = buildCorpus(
    [
      shape('orders', {
        op: 'AND',
        filters: [{ fieldPath: 'b', op: 'EQUAL' }, { fieldPath: 'a', op: 'EQUAL' }],
      }),
    ],
    [],
  );
  const other = buildCorpus(
    [
      shape('orders', {
        op: 'AND',
        filters: [{ fieldPath: 'a', op: 'EQUAL' }, { fieldPath: 'b', op: 'EQUAL' }],
      }),
    ],
    [],
  );
  assert.equal(serialiseCorpus(one), serialiseCorpus(other));
});

test('a corpus round-trips', () => {
  const corpus = buildCorpus(
    [
      shape('orders', { op: 'OR', filters: [{ fieldPath: 'a', op: 'EQUAL' }, { fieldPath: 'b', op: 'IN' }] }, [
        { fieldPath: 'a', direction: 'DESCENDING' },
      ]),
      shape('items'),
    ],
    ['listen-query'],
  );
  assert.deepEqual(parseCorpus(serialiseCorpus(corpus)), corpus);
});

test('an unknown corpusVersion is refused rather than read as far as it goes', () => {
  const text = serialiseCorpus(buildCorpus([], [])).replace('"corpusVersion": 1', '"corpusVersion": 2');
  assert.throws(() => parseCorpus(text), (error) => error instanceof CorpusError && /corpusVersion/.test(error.message));
});

test('a key that does not describe its own query is refused', () => {
  const document = JSON.parse(serialiseCorpus(buildCorpus([shape('orders')], [])));
  document.queries[0].key = 'orders::COLLECTION::AND(a:EQUAL)::';
  assert.throws(() => parseCorpus(JSON.stringify(document)), CorpusError);
});

test('a where that is not in normalised form is refused', () => {
  const document = JSON.parse(
    serialiseCorpus(
      buildCorpus(
        [
          shape('orders', {
            op: 'AND',
            filters: [{ fieldPath: 'a', op: 'EQUAL' }, { fieldPath: 'b', op: 'EQUAL' }],
          }),
        ],
        [],
      ),
    ),
  );
  document.queries[0].where.filters.reverse();
  assert.throws(() => parseCorpus(JSON.stringify(document)), (error) => /normalised/.test(error.message));
});

test('a node that is both a leaf and a composite is refused', () => {
  const document = JSON.parse(serialiseCorpus(buildCorpus([shape('orders')], [])));
  document.queries[0].where = { op: 'AND', filters: [], fieldPath: 'a' };
  assert.throws(() => parseCorpus(JSON.stringify(document)), (error) => /both/.test(error.message));
});

test('a member the format does not define is refused rather than ignored', () => {
  const document = JSON.parse(serialiseCorpus(buildCorpus([shape('orders')], [])));
  document.queries[0].note = 'added by hand';
  assert.throws(() => parseCorpus(JSON.stringify(document)), (error) => /does not define/.test(error.message));
});

test('a skip reason outside the closed vocabulary is refused', () => {
  const document = JSON.parse(serialiseCorpus(buildCorpus([], [])));
  document.skipped = ['something-that-happened'];
  assert.throws(() => parseCorpus(JSON.stringify(document)), CorpusError);
});

test('two entries sharing a key are refused', () => {
  const document = JSON.parse(serialiseCorpus(buildCorpus([shape('orders')], [])));
  document.queries.push(structuredClone(document.queries[0]));
  assert.throws(() => parseCorpus(JSON.stringify(document)), (error) => /share the key/.test(error.message));
});

test('an interrupted write leaves the previous corpus intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-corpus-'));
  try {
    const path = join(directory, 'firestore.queries.json');
    writeCorpus(path, buildCorpus([shape('orders')], []));
    const before = readFileSync(path, 'utf8');

    // A corpus that cannot be serialised: the write must fail before the rename, not halfway
    // through the destination.
    const unserialisable = { corpusVersion: CORPUS_VERSION, queries: [], skipped: [] };
    Object.defineProperty(unserialisable, 'queries', {
      get() {
        throw new Error('serialisation exploded');
      },
      enumerable: true,
    });
    assert.throws(() => writeCorpus(path, unserialisable));
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a corpus is written whole, replacing what was there', () => {
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-corpus-'));
  try {
    const path = join(directory, 'firestore.queries.json');
    writeFileSync(path, 'not a corpus at all');
    writeCorpus(path, buildCorpus([shape('orders')], []));
    assert.equal(parseCorpus(readFileSync(path, 'utf8')).queries.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
