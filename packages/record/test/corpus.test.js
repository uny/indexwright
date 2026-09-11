import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildCorpus,
  CORPUS_VERSION,
  CorpusError,
  parseCorpus,
  READABLE_CORPUS_VERSIONS,
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
  assert.deepEqual(document, { corpusVersion: CORPUS_VERSION, producers: [], queries: [], skipped: [] });
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
  const text = serialiseCorpus(buildCorpus([], [])).replace('"corpusVersion": 2', '"corpusVersion": 3');
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

test('a write that fails after the temp file leaves neither a truncated corpus nor the temp file', () => {
  // The failure is induced at the rename rather than at serialisation, so this covers the
  // temp-file path itself: a rename onto a directory fails, and what it leaves behind is what a
  // non-atomic write would get wrong.
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-corpus-'));
  try {
    const path = join(directory, 'occupied');
    mkdirSync(path);
    assert.throws(() => writeCorpus(path, buildCorpus([shape('orders')], [])));
    // Only the directory: the temp file was created and then cleaned up.
    assert.deepEqual(readdirSync(directory), ['occupied']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a corpus that cannot be serialised leaves the previous one intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-corpus-'));
  try {
    const path = join(directory, 'firestore.queries.json');
    writeCorpus(path, buildCorpus([shape('orders')], []));
    const before = readFileSync(path, 'utf8');

    // A corpus that cannot be serialised: the write must fail before the rename, not halfway
    // through the destination.
    const unserialisable = { corpusVersion: CORPUS_VERSION, producers: [], queries: [], skipped: [] };
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

test('a corpus nested past what the reader descends is refused as a corpus error', () => {
  // parseCorpus recurses once per filter level, and a corpus is a committed file that arrives
  // through review rather than from a trusted caller. Without a ceiling this is a RangeError
  // escaping a function documented to fail with CorpusError.
  // Just past the ceiling rather than pathologically deep: 20000 would put `JSON.parse` itself
  // near the stack limit, and the test would then be red for a reason that is not the fix.
  const depth = 200;
  const where =
    '{"op":"AND","filters":['.repeat(depth) + '{"fieldPath":"a","op":"EQUAL"}' + ']}'.repeat(depth);
  const source =
    '{"corpusVersion":2,"producers":[],"queries":[{"key":"x","collectionGroup":"c","queryScope":"COLLECTION",' +
    `"where":${where},"orderBy":[]}],"skipped":[]}`;
  assert.throws(
    () => parseCorpus(source),
    (error) => error instanceof CorpusError && /nests deeper/.test(error.message),
  );
});

test('a corpus from a later format is refused by version, not by its members', () => {
  // Adding a top-level member is the normal reason to bump the version, so a reader that checked
  // the member set first would blame a stray field instead of naming the version it cannot read.
  assert.throws(
    () => parseCorpus('{"corpusVersion":3,"producers":[],"queries":[],"skipped":[],"capturedAt":"2026-08-11"}'),
    (error) => error instanceof CorpusError && /corpusVersion 3 is not readable/.test(error.message),
  );
});

test('a corpus whose entries are out of order is refused', () => {
  // The file is diff-stable only because one set of entries has one order. A reader that took any
  // order would round-trip a corpus to different bytes than the ones it read.
  const document = JSON.parse(serialiseCorpus(buildCorpus([shape('a'), shape('z')], ['listen-query', 'vector-query'])));
  const queriesReversed = structuredClone(document);
  queriesReversed.queries.reverse();
  assert.throws(
    () => parseCorpus(JSON.stringify(queriesReversed)),
    (error) => error instanceof CorpusError && /not sorted/.test(error.message),
  );
  const skippedReversed = structuredClone(document);
  skippedReversed.skipped.reverse();
  assert.throws(
    () => parseCorpus(JSON.stringify(skippedReversed)),
    (error) => error instanceof CorpusError && /not sorted/.test(error.message),
  );
});

test('the write does not follow a symlink planted at a guessable temp name', () => {
  // The corpus is often written into a shared workspace. A temp name derived from the pid is one
  // another user can pre-create as a symlink to a file of their choosing, and a plain write would
  // then truncate that file instead. The name is random now, and created exclusively besides.
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-corpus-'));
  try {
    const victim = join(directory, 'victim');
    writeFileSync(victim, 'not to be touched');
    symlinkSync(victim, join(directory, `.${process.pid}.indexwright-corpus.tmp`));

    writeCorpus(join(directory, 'firestore.queries.json'), buildCorpus([shape('orders')], []));

    assert.equal(readFileSync(victim, 'utf8'), 'not to be touched');
    assert.deepEqual(readdirSync(directory).sort(), [
      `.${process.pid}.indexwright-corpus.tmp`,
      'firestore.queries.json',
      'victim',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a producer named by the caller is written into the file, in the documented order', () => {
  const document = JSON.parse(
    serialiseCorpus(buildCorpus([], [], [{ name: 'orders-service', revision: '9c1f2ab' }])),
  );
  assert.deepEqual(Object.keys(document), ['corpusVersion', 'producers', 'queries', 'skipped']);
  assert.deepEqual(document.producers, [{ name: 'orders-service', revision: '9c1f2ab' }]);
  assert.deepEqual(Object.keys(document.producers[0]), ['name', 'revision']);
});

test('a corpus that named no producer says so with an empty list, not by omitting the member', () => {
  // The same rule as `skipped`: every member is always present, so "none" is a reading a file
  // states rather than one a reader infers from silence.
  assert.deepEqual(JSON.parse(serialiseCorpus(buildCorpus([], []))).producers, []);
});

test('a producer with no revision records null rather than an empty string', () => {
  const document = JSON.parse(serialiseCorpus(buildCorpus([], [], [{ name: 'suite', revision: null }])));
  assert.deepEqual(document.producers, [{ name: 'suite', revision: null }]);
});

test('producers are a sorted set on the pair, so two revisions of one producer are two entries', () => {
  // Two revisions of one suite is exactly what a merged corpus (SPEC §7) has to be able to show:
  // de-duplicating on the name would collapse a current part and a stale part into one line.
  const corpus = buildCorpus([], [], [
    { name: 'b', revision: '2' },
    { name: 'a', revision: '9c1f' },
    { name: 'a', revision: null },
    { name: 'b', revision: '2' },
    { name: 'a', revision: '1a0b' },
  ]);
  assert.deepEqual(corpus.producers, [
    { name: 'a', revision: null },
    { name: 'a', revision: '1a0b' },
    { name: 'a', revision: '9c1f' },
    { name: 'b', revision: '2' },
  ]);
});

test('a corpus carrying producers round-trips to the bytes it was read from', () => {
  const text = serialiseCorpus(
    buildCorpus([shape('orders')], ['listen-query'], [{ name: 'a', revision: null }, { name: 'b', revision: 'r' }]),
  );
  assert.equal(serialiseCorpus(parseCorpus(text)), text);
});

test('a version-1 corpus is read as one naming no producer, not refused', () => {
  // The member is optional by construction, so every corpus committed before this format version
  // stays readable. Refusing them was the outcome the version bump existed to avoid.
  const corpus = parseCorpus('{"corpusVersion":1,"queries":[],"skipped":[]}');
  assert.equal(corpus.corpusVersion, 1);
  assert.deepEqual(corpus.producers, []);
});

test('a version-1 corpus round-trips to version 1, without a producers member', () => {
  // A reader that knows two versions must not rewrite a file into the other one: the corpus is a
  // committed artefact, and a read that changed its version would show up as a diff nobody made.
  const text = '{\n  "corpusVersion": 1,\n  "queries": [],\n  "skipped": []\n}\n';
  assert.equal(serialiseCorpus(parseCorpus(text)), text);
});

test('a version-1 corpus carrying a producers member is refused', () => {
  // The member set is part of what the version names. Reading it anyway would accept a file no
  // writer produces and give the integer nothing to announce.
  assert.throws(
    () => parseCorpus('{"corpusVersion":1,"producers":[],"queries":[],"skipped":[]}'),
    (error) => error instanceof CorpusError && /producers/.test(error.message),
  );
});

test('a version-2 corpus with no producers member is refused', () => {
  assert.throws(
    () => parseCorpus('{"corpusVersion":2,"queries":[],"skipped":[]}'),
    (error) => error instanceof CorpusError && /producers/.test(error.message),
  );
});

test('an empty producer name is refused, since the way to name no producer is to have no entry', () => {
  assert.throws(
    () => parseCorpus('{"corpusVersion":2,"producers":[{"name":"","revision":null}],"queries":[],"skipped":[]}'),
    (error) => error instanceof CorpusError && /name is empty/.test(error.message),
  );
});

test('an empty revision is refused, because an unnamed revision is null', () => {
  assert.throws(
    () => parseCorpus('{"corpusVersion":2,"producers":[{"name":"a","revision":""}],"queries":[],"skipped":[]}'),
    (error) => error instanceof CorpusError && /revision is empty/.test(error.message),
  );
});

test('a producers list out of order is refused, as queries and skipped are', () => {
  assert.throws(
    () =>
      parseCorpus(
        '{"corpusVersion":2,"producers":[{"name":"b","revision":null},{"name":"a","revision":null}],' +
          '"queries":[],"skipped":[]}',
      ),
    (error) => error instanceof CorpusError && /not sorted/.test(error.message),
  );
});

test('a producers list repeating a pair is refused', () => {
  assert.throws(
    () =>
      parseCorpus(
        '{"corpusVersion":2,"producers":[{"name":"a","revision":"1"},{"name":"a","revision":"1"}],' +
          '"queries":[],"skipped":[]}',
      ),
    (error) => error instanceof CorpusError && /repeats/.test(error.message),
  );
});

test('a producer carrying a member the format does not define is refused', () => {
  assert.throws(
    () =>
      parseCorpus(
        '{"corpusVersion":2,"producers":[{"name":"a","revision":null,"host":"laptop.local"}],' +
          '"queries":[],"skipped":[]}',
      ),
    CorpusError,
  );
});

test('a corpus this package writes is one it can read back, producers included', () => {
  // The invariant the filter-depth ceiling exists for, held on the other side too: the CLI refuses
  // an empty value before it gets here, but the JS API reaches `buildCorpus` directly.
  assert.throws(() => buildCorpus([], [], [{ name: '', revision: null }]), CorpusError);
  assert.throws(() => buildCorpus([], [], [{ name: 'a', revision: '' }]), CorpusError);
  // An untyped caller omits the revision rather than writing `null`, and `JSON.stringify` drops an
  // `undefined` member — so the file would carry a producer with no `revision` at all, which this
  // package's own reader refuses. Refused where it enters instead.
  assert.throws(() => buildCorpus([], [], [{ name: 'a' }]), CorpusError);
  assert.throws(() => buildCorpus([], [], [{ name: 7, revision: null }]), CorpusError);
});

test('two producers are two entries even when a name holds the character the set is keyed on', () => {
  // The pair is keyed as a tuple rather than by joining on a separator: `Producer` reserves no
  // character, so any separator is one a name may end with and a revision may begin with, and the
  // two distinct identities would key the same. One of them would be dropped without a word.
  const corpus = buildCorpus([], [], [
    { name: 'a\u0000b', revision: null },
    { name: 'a', revision: 'b' },
  ]);
  assert.equal(corpus.producers.length, 2);
});

test('a corpus at a version with no producers member is refused rather than written without them', () => {
  // Dropping them is the silent loss the member exists against, and promoting the file to version 2
  // would rewrite a corpus the caller only meant to add to. Neither: it is refused.
  const version1 = parseCorpus('{"corpusVersion":1,"queries":[],"skipped":[]}');
  assert.throws(
    () => serialiseCorpus({ ...version1, producers: [{ name: 'suite', revision: null }] }),
    (error) => error instanceof CorpusError && /version 1/.test(error.message),
  );
});

test('a corpus object with no producers member at all is refused by name, not by TypeError', () => {
  // What a caller written against the previous format version builds by hand. The refusal has to
  // name the member it wants; a bare `TypeError` from a `.map` names neither it nor the version.
  assert.throws(
    () => serialiseCorpus({ corpusVersion: 2, queries: [], skipped: [] }),
    (error) => error instanceof CorpusError && /producers/.test(error.message),
  );
});

test('a producers list out of order on the revision is refused, and the refusal names the pair', () => {
  // Sorted on the pair, so a refusal that named only the name would print it on both sides of
  // "follows" and say nothing about what to reorder.
  assert.throws(
    () =>
      parseCorpus(
        '{"corpusVersion":2,"producers":[{"name":"a","revision":"1"},{"name":"a","revision":null}],' +
          '"queries":[],"skipped":[]}',
      ),
    (error) => error instanceof CorpusError && /not sorted/.test(error.message) && /no revision/.test(error.message),
  );
});

test('the readable versions are frozen, so a caller cannot widen what this package accepts', () => {
  // `readonly` is erased at runtime and `parseCorpus` reads this array to decide what it will
  // accept: an appended version is one the reader has no members written down for.
  assert.throws(() => READABLE_CORPUS_VERSIONS.push(3), TypeError);
  assert.deepEqual([...READABLE_CORPUS_VERSIONS], [1, 2]);
});
