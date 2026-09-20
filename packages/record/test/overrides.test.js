import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyseOverrides, parseDocument } from 'indexwright';
import {
  DEFAULT_COLLECTION_GROUP,
  DEFAULT_FIELD_PATH,
  FIELD_UNREADABLE_REASONS,
  isVouched,
  liveSingleFieldIndexes,
  OVERRIDE_INCOMPARABLE_REASONS,
  reconcileOverrides,
} from '../dist/index.js';

/** A candidate set, from overrides written the way a `firestore.indexes.json` writes them. */
const declare = (...fieldOverrides) => analyseOverrides({ indexes: [], fieldOverrides });
/** The same, through the parser, for a declaration that leans on what `parse.ts` fills in. */
const parsed = (...fieldOverrides) =>
  analyseOverrides(parseDocument(JSON.stringify({ indexes: [], fieldOverrides })));

const named = (collectionGroup, fieldPath) =>
  `projects/p/databases/(default)/collectionGroups/${collectionGroup}/fields/${fieldPath}`;

/** One nested index as `fields.list` reports it: the direction on the one field, a `state` beside. */
const nested = (fieldPath, config, options = {}) => ({
  queryScope: options.queryScope ?? 'COLLECTION',
  fields: [{ fieldPath, ...config }],
  state: options.state ?? 'READY',
  ...(options.apiScope === undefined ? {} : { apiScope: options.apiScope }),
  ...(options.density === undefined ? {} : { density: options.density }),
});
const asc = (fieldPath, options) => nested(fieldPath, { order: 'ASCENDING' }, options);
const desc = (fieldPath, options) => nested(fieldPath, { order: 'DESCENDING' }, options);
const contains = (fieldPath, options) => nested(fieldPath, { arrayConfig: 'CONTAINS' }, options);

/** A live field carrying its own configuration, which is what an override is. */
const live = (collectionGroup, fieldPath, indexes, extra = {}) => ({
  name: named(collectionGroup, fieldPath),
  indexConfig: { indexes, usesAncestorConfig: false, ancestorField: '', reverting: false, ...extra },
});

/** `__default__/*` as a standard database lists it. */
const theDefault = () =>
  live(DEFAULT_COLLECTION_GROUP, DEFAULT_FIELD_PATH, [asc('*'), desc('*'), contains('*')]);

test('a declared override matches the live field it describes, and the set is vouched for', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    fieldPath: 'tags',
    indexes: [{ queryScope: 'COLLECTION_GROUP', arrayConfig: 'CONTAINS' }],
  });
  const observed = [theDefault(), live('posts', 'tags', [contains('tags', { queryScope: 'COLLECTION_GROUP' })])];

  const result = reconcileOverrides(candidate, observed);
  assert.equal(result.verdict, 'identical');
  assert.ok(isVouched(result));
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].key, 'posts::tags::COLLECTION_GROUP:CONTAINS');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
});

test('the default field is neither matched nor extra, because no declaration ever names it', () => {
  // The Firebase CLI drops `__default__/*` from its output by name; a file it wrote never declares
  // it, so a listing holding it alone must reconcile against an empty declaration as identical.
  const result = reconcileOverrides(declare(), [theDefault()]);
  assert.equal(result.verdict, 'identical');
  assert.deepEqual(result.extra, []);
  assert.deepEqual(result.unreadable, []);
});

test('a default field holding something other than the three defaults is unreadable', () => {
  // Every override the linter models is a departure from ascending, descending, and contains at
  // collection scope. A database whose default were different would serve queries no declaration
  // accounts for, and a run that reported on it would be vouching for a model that does not hold.
  const changed = live(DEFAULT_COLLECTION_GROUP, DEFAULT_FIELD_PATH, [asc('*'), desc('*')]);
  const result = reconcileOverrides(declare(), [changed]);
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(result.unreadable.length, 1);
  assert.equal(result.unreadable[0].reason, 'default-changed');
  assert.equal(result.unreadable[0].detail, 'COLLECTION:ASCENDING|COLLECTION:DESCENDING');
});

test('an exemption is a field with no indexes, and matches a live field listing none', () => {
  // proto3 omits an empty repeated, so an exempted field arrives with no `indexes` at all — and
  // that is an exemption, not an unknown, because the field owns its configuration.
  const candidate = declare({ collectionGroup: 'posts', fieldPath: 'body', indexes: [] });
  const bare = { name: named('posts', 'body'), indexConfig: { usesAncestorConfig: false } };
  const result = reconcileOverrides(candidate, [bare]);
  assert.equal(result.verdict, 'identical');
  assert.equal(result.matched[0].key, 'posts::body::');
});

test('a field that inherits its configuration and does not say what is unreadable, not an exemption', () => {
  // The `OR ttlConfig:*` half of the filter admits a TTL-only field, which inherits its indexes.
  // The listing normally materialises them; when it does not, the set is whatever the ancestor
  // holds, which this entry does not tell.
  const inheriting = {
    name: named('posts', 'expiresAt'),
    indexConfig: { usesAncestorConfig: true, ancestorField: named('__default__', '*') },
    ttlConfig: { state: 'ACTIVE' },
  };
  const result = reconcileOverrides(declare(), [inheriting]);
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(result.unreadable[0].reason, 'indexes-missing');
});

test('an inheriting field with an empty set, or a field with no indexConfig at all, is unreadable too', () => {
  // Zero readable entries on a field that inherits is not an exemption — the ancestor holds
  // something — and a field with no `indexConfig` cannot say which of the two it is. Reading either
  // as an exemption would put it in `extra`, a confident divergence about an entry nobody read.
  const emptyInheriting = live('posts', 'a', [], { usesAncestorConfig: true });
  const noConfig = { name: named('posts', 'a'), ttlConfig: { state: 'ACTIVE' } };
  for (const entry of [emptyInheriting, noConfig]) {
    const result = reconcileOverrides(declare(), [entry]);
    assert.equal(result.verdict, 'indeterminate');
    assert.equal(result.unreadable[0].reason, 'indexes-missing');
    assert.deepEqual(result.extra, []);
  }
});

test('an inheriting field may name the ancestor wildcard as its path; an owning field may not', () => {
  const candidate = parsed({
    collectionGroup: 'posts',
    fieldPath: 'expiresAt',
    ttl: true,
    indexes: [{ order: 'ASCENDING' }, { order: 'DESCENDING' }, { arrayConfig: 'CONTAINS' }],
  });
  const materialised = [asc('*'), desc('*'), contains('*')];
  const inheriting = live('posts', 'expiresAt', materialised, { usesAncestorConfig: true });
  assert.equal(reconcileOverrides(candidate, [inheriting]).verdict, 'identical');
  const owning = live('posts', 'expiresAt', materialised);
  assert.equal(reconcileOverrides(candidate, [owning]).unreadable[0].reason, 'field-unreadable');
});

test('a TTL-only field with the inherited set materialised matches the declaration the CLI exports for it', () => {
  // `firebase firestore:indexes` writes such a field out as `ttl: true` with the three defaults
  // spelled out. That declaration has to match, or every file the CLI generates reads as diverged.
  const candidate = parsed({
    collectionGroup: 'posts',
    fieldPath: 'expiresAt',
    ttl: true,
    indexes: [{ order: 'ASCENDING' }, { order: 'DESCENDING' }, { arrayConfig: 'CONTAINS' }],
  });
  const observed = [
    {
      ...live('posts', 'expiresAt', [asc('expiresAt'), desc('expiresAt'), contains('expiresAt')], {
        usesAncestorConfig: true,
        ancestorField: named('__default__', '*'),
      }),
      ttlConfig: { state: 'ACTIVE' },
    },
  ];
  const result = reconcileOverrides(candidate, observed);
  assert.equal(result.verdict, 'identical');
});

test('ttl is compared on neither side, because it is not a coverage question', () => {
  const withTtl = declare({
    collectionGroup: 'posts',
    fieldPath: 'expiresAt',
    ttl: true,
    indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }],
  });
  const withoutTtl = declare({
    collectionGroup: 'posts',
    fieldPath: 'expiresAt',
    indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }],
  });
  const observed = [live('posts', 'expiresAt', [asc('expiresAt')])];
  const withTtlLive = [{ ...observed[0], ttlConfig: { state: 'ACTIVE' } }];

  assert.equal(reconcileOverrides(withTtl, observed).verdict, 'identical');
  assert.equal(reconcileOverrides(withoutTtl, withTtlLive).verdict, 'identical');
});

test('a declared override the target does not hold is missing, not silently tolerated', () => {
  const candidate = declare(
    { collectionGroup: 'posts', fieldPath: 'tags', indexes: [{ queryScope: 'COLLECTION_GROUP', arrayConfig: 'CONTAINS' }] },
    { collectionGroup: 'posts', fieldPath: 'body', indexes: [] },
  );
  const observed = [live('posts', 'tags', [contains('tags', { queryScope: 'COLLECTION_GROUP' })])];

  const result = reconcileOverrides(candidate, observed);
  assert.equal(result.verdict, 'diverged');
  assert.ok(!isVouched(result));
  assert.deepEqual(result.missing.map((override) => override.key), ['posts::body::']);
});

test('a live override no declaration covers is extra, because it makes the report read as a pass', () => {
  // The quiet direction of issue #53: an undeclared `COLLECTION_GROUP` override serves a query
  // the candidate set alone would fail, so replay finds nothing.
  const observed = [
    theDefault(),
    live('posts', 'tags', [contains('tags', { queryScope: 'COLLECTION_GROUP' })]),
  ];
  const result = reconcileOverrides(declare(), observed);
  assert.equal(result.verdict, 'diverged');
  assert.deepEqual(result.extra.map((entry) => entry.key), ['posts::tags::COLLECTION_GROUP:CONTAINS']);
});

test('the declared set is a set: a live listing in another order, or with a repeat, still matches', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    fieldPath: 'score',
    indexes: [
      { queryScope: 'COLLECTION_GROUP', order: 'DESCENDING' },
      { queryScope: 'COLLECTION', order: 'ASCENDING' },
    ],
  });
  const observed = [
    live('posts', 'score', [
      asc('score'),
      desc('score', { queryScope: 'COLLECTION_GROUP' }),
      asc('score'),
    ]),
  ];
  const result = reconcileOverrides(candidate, observed);
  assert.equal(result.verdict, 'identical');
  assert.equal(result.matched[0].key, 'posts::score::COLLECTION:ASCENDING|COLLECTION_GROUP:DESCENDING');
});

test('the set is part of the identity, so a field with one more index does not match', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    fieldPath: 'score',
    indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }],
  });
  const observed = [live('posts', 'score', [asc('score'), desc('score')])];
  const result = reconcileOverrides(candidate, observed);
  assert.equal(result.verdict, 'diverged');
  assert.equal(result.missing.length, 1);
  assert.equal(result.extra.length, 1);
});

test('a scope omitted in the declaration is COLLECTION, so it matches what the service reports', () => {
  const candidate = parsed({ collectionGroup: 'posts', fieldPath: 'score', indexes: [{ order: 'ASCENDING' }] });
  const observed = [live('posts', 'score', [asc('score')])];
  assert.equal(reconcileOverrides(candidate, observed).verdict, 'identical');
});

test('the field path is everything after fields/, so a dotted path is one field', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    fieldPath: 'meta.score',
    indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }],
  });
  const observed = [live('posts', 'meta.score', [asc('meta.score')])];
  const result = reconcileOverrides(candidate, observed);
  assert.equal(result.verdict, 'identical');
  assert.equal(result.matched[0].key, 'posts::meta.score::COLLECTION:ASCENDING');
});

test('a resource name that is not a collection group field path is unreadable, not extra', () => {
  const stray = { name: 'projects/p/databases/(default)/collectionGroups/posts/indexes/abc', indexConfig: { indexes: [] } };
  const result = reconcileOverrides(declare(), [stray]);
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(result.unreadable[0].reason, 'name-unparseable');
});

test('a nested index that is not exactly one field, or names another, is unreadable', () => {
  const twoFields = live('posts', 'a', [{ queryScope: 'COLLECTION', fields: [{ fieldPath: 'a', order: 'ASCENDING' }, { fieldPath: 'b', order: 'ASCENDING' }] }]);
  const otherField = live('posts', 'a', [asc('b')]);
  const noConfig = live('posts', 'a', [{ queryScope: 'COLLECTION', fields: [{ fieldPath: 'a' }] }]);
  for (const entry of [twoFields, otherField, noConfig]) {
    const result = reconcileOverrides(declare(), [entry]);
    assert.equal(result.verdict, 'indeterminate');
    assert.equal(result.unreadable[0].reason, 'field-unreadable');
  }
});

test('a missing query scope on a nested index is unreadable rather than defaulted', () => {
  // The declaration side fills in `COLLECTION` when the scope is omitted, following the CLI. The
  // live side does not: the service always sends one, and an entry without it is not the service.
  const entry = live('posts', 'a', [{ fields: [{ fieldPath: 'a', order: 'ASCENDING' }] }]);
  const result = reconcileOverrides(declare(), [entry]);
  assert.equal(result.unreadable[0].reason, 'query-scope-missing');
});

test('an apiScope or density on a nested index is held to the same rule as a composite', () => {
  const datastore = live('posts', 'a', [asc('a', { apiScope: 'DATASTORE_MODE_API' })]);
  const dense = live('posts', 'a', [asc('a', { density: 'DENSE' })]);
  const native = live('posts', 'a', [asc('a', { apiScope: 'ANY_API', density: 'SPARSE_ALL' })]);
  assert.equal(reconcileOverrides(declare(), [datastore]).unreadable[0].reason, 'api-scope-unrecognised');
  assert.equal(reconcileOverrides(declare(), [dense]).unreadable[0].reason, 'density-unrecognised');
  const candidate = declare({ collectionGroup: 'posts', fieldPath: 'a', indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }] });
  assert.equal(reconcileOverrides(candidate, [native]).verdict, 'identical');
});

test('a declaration setting a density or a non-native apiScope is refused, as the live side is', () => {
  const dense = declare({
    collectionGroup: 'posts',
    fieldPath: 'a',
    indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING', density: 'DENSE' }],
  });
  const datastore = declare({
    collectionGroup: 'posts',
    fieldPath: 'a',
    indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING', apiScope: 'DATASTORE_MODE_API' }],
  });
  const observed = [live('posts', 'a', [asc('a')])];
  for (const [candidate, reason] of [[dense, 'density-unrecognised'], [datastore, 'api-scope-unrecognised']]) {
    const result = reconcileOverrides(candidate, observed);
    assert.equal(result.verdict, 'indeterminate');
    assert.equal(result.incomparable[0].reason, reason);
    assert.equal(result.incomparable[0].key, 'posts::a::COLLECTION:ASCENDING');
    // Refused, not also missing: the declaration claimed its identity before the match was tried.
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
  }
});

test('a declared vector index whose dimension is not a number is refused, not asserted diverged', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    fieldPath: 'embedding',
    indexes: [{ queryScope: 'COLLECTION', vectorConfig: { dimension: '128', flat: {} } }],
  });
  const result = reconcileOverrides(candidate, []);
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(result.incomparable[0].reason, 'field-unreadable');
  assert.equal(result.incomparable[0].detail, 'COLLECTION:VECTOR(?)');
});

test('an unreadable entry outranks a divergence it could otherwise be mistaken for', () => {
  const candidate = declare({ collectionGroup: 'posts', fieldPath: 'a', indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING' }] });
  const observed = [{ name: 'nonsense', indexConfig: { indexes: [] } }];
  const result = reconcileOverrides(candidate, observed);
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(result.missing.length, 1);
});

test('every outcome is sorted, so a report does not depend on listing order', () => {
  const candidate = declare(
    { collectionGroup: 'posts', fieldPath: 'z', indexes: [] },
    { collectionGroup: 'posts', fieldPath: 'a', indexes: [] },
  );
  const observed = [
    live('users', 'z', [asc('z')]),
    live('users', 'a', [asc('a')]),
    { name: 'stray-b', indexConfig: { indexes: [] } },
    { name: 'stray-a', indexConfig: { indexes: [] } },
  ];
  const result = reconcileOverrides(candidate, observed);
  assert.deepEqual(result.missing.map((o) => o.key), ['posts::a::', 'posts::z::']);
  assert.deepEqual(result.extra.map((o) => o.key), ['users::a::COLLECTION:ASCENDING', 'users::z::COLLECTION:ASCENDING']);
  assert.deepEqual(result.unreadable.map((o) => o.name), ['stray-a', 'stray-b']);
});

test('the unreadable and incomparable reasons are the ones the module can actually produce', () => {
  const produced = new Set();
  const cases = [
    { name: 'nonsense', indexConfig: { indexes: [] } },
    { name: named('posts', 'a'), indexConfig: { usesAncestorConfig: true } },
    live('posts', 'a', [{ fields: [{ fieldPath: 'a', order: 'ASCENDING' }] }]),
    live('posts', 'a', [asc('b')]),
    live('posts', 'a', [asc('a', { apiScope: 'DATASTORE_MODE_API' })]),
    live('posts', 'a', [asc('a', { density: 'DENSE' })]),
    live(DEFAULT_COLLECTION_GROUP, DEFAULT_FIELD_PATH, []),
  ];
  for (const entry of cases) {
    for (const found of reconcileOverrides(declare(), [entry]).unreadable) produced.add(found.reason);
  }
  assert.deepEqual([...produced].sort(), [...FIELD_UNREADABLE_REASONS].sort());

  const declaredCases = [
    declare({ collectionGroup: 'p', fieldPath: 'a', indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING', apiScope: 'DATASTORE_MODE_API' }] }),
    declare({ collectionGroup: 'p', fieldPath: 'a', indexes: [{ queryScope: 'COLLECTION', order: 'ASCENDING', density: 'DENSE' }] }),
    declare({ collectionGroup: 'p', fieldPath: 'a', indexes: [{ queryScope: 'COLLECTION', vectorConfig: { dimension: 'x' } }] }),
  ];
  const refused = new Set();
  for (const candidate of declaredCases) {
    for (const found of reconcileOverrides(candidate, []).incomparable) refused.add(found.reason);
  }
  assert.deepEqual([...refused].sort(), [...OVERRIDE_INCOMPARABLE_REASONS].sort());
});

test('the nested indexes are flattened for the readiness gate with stable, distinct names', () => {
  const fields = [
    theDefault(),
    live('posts', 'tags', [
      contains('tags', { queryScope: 'COLLECTION_GROUP', state: 'CREATING' }),
      asc('tags'),
    ]),
    { name: named('posts', 'body'), indexConfig: { usesAncestorConfig: false } },
  ];
  const flattened = liveSingleFieldIndexes(fields);
  assert.deepEqual(flattened, [
    { name: `${named('__default__', '*')}#COLLECTION:ASCENDING`, state: 'READY' },
    { name: `${named('__default__', '*')}#COLLECTION:DESCENDING`, state: 'READY' },
    { name: `${named('__default__', '*')}#COLLECTION:CONTAINS`, state: 'READY' },
    { name: `${named('posts', 'tags')}#COLLECTION_GROUP:CONTAINS`, state: 'CREATING' },
    { name: `${named('posts', 'tags')}#COLLECTION:ASCENDING`, state: 'READY' },
  ]);
  // Named even when unreadable: naming what is building is this function's job, refusing is not.
  const odd = liveSingleFieldIndexes([live('posts', 'a', [{ fields: [{ fieldPath: 'a' }], state: 'READY' }])]);
  assert.equal(odd[0].name, `${named('posts', 'a')}#undefined:UNKNOWN`);
});

// --- against a real listing ---------------------------------------------------------------------

/** What a real database returned, as three tools rendered it. See the fixture's `note`. */
const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/live-fields.json', import.meta.url)), 'utf8'),
);

test('the file firebase generates reconciles against the database it was generated from', () => {
  // The whole point, end to end: `firebase firestore:indexes` read the target, wrote
  // `fieldOverrides`, and that declaration must be vouched for against the listing it came from —
  // through either client rendering, since gcloud omits every proto3 default the admin client fills.
  const candidate = parsed(...FIXTURE.declarationByFirebaseCli);
  for (const rendering of ['liveByAdminClient', 'liveByGcloud']) {
    const result = reconcileOverrides(candidate, FIXTURE[rendering]);
    assert.equal(result.verdict, 'identical', `${rendering}: ${JSON.stringify(result)}`);
    assert.deepEqual(
      result.matched.map((entry) => entry.key),
      ['probe_fields::body::', 'probe_fields::tags::COLLECTION:ASCENDING|COLLECTION_GROUP:CONTAINS'],
    );
  }
});

test('the default is in the filtered listing, holds the three defaults, and is neither matched nor extra', () => {
  // `defaultIsListedUnderTheFilter`. The CLI drops it, so the declaration above never names it, and
  // the reconciliation above only passes because this module recognises it by name.
  const theDefault = FIXTURE.liveByAdminClient.find((field) => field.name.endsWith('/__default__/fields/*'));
  assert.ok(theDefault);
  assert.equal(theDefault.indexConfig.usesAncestorConfig, false);
  assert.deepEqual(
    theDefault.indexConfig.indexes.map((index) => `${index.queryScope}:${index.fields[0].order ?? index.fields[0].arrayConfig}`),
    ['COLLECTION:ASCENDING', 'COLLECTION:DESCENDING', 'COLLECTION:CONTAINS'],
  );
  assert.ok(!FIXTURE.declarationByFirebaseCli.some((override) => override.collectionGroup === '__default__'));
});

test('an exemption really does arrive with no indexes, and reads as one', () => {
  // `exemptionArrivesWithNoIndexes`: `[]` from the client, no key at all from gcloud.
  const byClient = FIXTURE.liveByAdminClient.find((field) => field.name.endsWith('/fields/body'));
  const byGcloud = FIXTURE.liveByGcloud.find((field) => field.name.endsWith('/fields/body'));
  assert.deepEqual(byClient.indexConfig.indexes, []);
  assert.equal(byGcloud.indexConfig.indexes, undefined);
  assert.equal(byGcloud.indexConfig.usesAncestorConfig, undefined);
  const candidate = declare({ collectionGroup: 'probe_fields', fieldPath: 'body', indexes: [] });
  assert.equal(reconcileOverrides(candidate, [byClient]).verdict, 'identical');
  assert.equal(reconcileOverrides(candidate, [byGcloud]).verdict, 'identical');
});

test('the density a nested index actually carries is one this version compares under', () => {
  // `nestedDensityIsUnspecified`: DENSITY_UNSPECIFIED here, SPARSE_ALL on a composite. Either alone
  // would let the other set shrink; both fixtures together are what pin `COMPARABLE_DENSITIES`.
  const densities = new Set(
    FIXTURE.liveByAdminClient.flatMap((field) => field.indexConfig.indexes.map((index) => index.density)),
  );
  assert.deepEqual([...densities], ['DENSITY_UNSPECIFIED']);
});

test('a real listing is readable, whichever tool rendered it, and every nested index is gated', () => {
  for (const rendering of ['liveByAdminClient', 'liveByGcloud']) {
    assert.deepEqual(reconcileOverrides(declare(), FIXTURE[rendering]).unreadable, []);
    const gated = liveSingleFieldIndexes(FIXTURE[rendering]);
    // Three on the default, two on `tags`, none on the exemption; all READY; nameless in the
    // listing (`nestedIndexesAreNameless`) and named here.
    assert.equal(gated.length, 5);
    assert.ok(gated.every((index) => index.state === 'READY'));
    assert.equal(new Set(gated.map((index) => index.name)).size, 5);
  }
});

test('the TTL-only case is not in the fixture, and the test suite says so rather than pretending', () => {
  // `ttlNotObserved`: the disposable project has no billing. What the module does with an
  // inheriting field rests on the Firebase CLI's source until a billed project re-observes it.
  assert.match(FIXTURE.source.refusals.ttl.stderr, /billing disabled/);
  assert.ok(!FIXTURE.liveByAdminClient.some((field) => field.ttlConfig !== null && field.ttlConfig !== undefined));
});
