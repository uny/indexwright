import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyse } from 'indexwright';
import { INCOMPARABLE_REASONS, isVouched, reconcile, UNREADABLE_REASONS } from '../dist/index.js';

/** A candidate set, from declarations written the way a `firestore.indexes.json` writes them. */
const declare = (...indexes) => analyse({ indexes });

const asc = (fieldPath) => ({ fieldPath, order: 'ASCENDING' });
const desc = (fieldPath) => ({ fieldPath, order: 'DESCENDING' });

const named = (collectionGroup, id = 'ix') =>
  `projects/p/databases/(default)/collectionGroups/${collectionGroup}/indexes/${id}`;

/** A live index as `collectionGroups.indexes.list` reports one: `__name__` included, `state` set. */
const live = (collectionGroup, fields, options = {}) => ({
  name: named(collectionGroup, options.id),
  state: 'READY',
  queryScope: options.queryScope ?? 'COLLECTION',
  fields,
  ...(options.apiScope === undefined ? {} : { apiScope: options.apiScope }),
});

test('a declaration matches the live index it describes, and the set is vouched for', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type'), desc('createdAt')],
  });
  // The live entry carries the document key the declaration left implicit.
  const observed = [live('posts', [asc('type'), desc('createdAt'), desc('__name__')])];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'identical');
  assert.ok(isVouched(result));
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].key, 'posts::COLLECTION::type:ASCENDING|createdAt:DESCENDING');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
});

test('the trailing __name__ is stripped on both sides, so writing it explicitly changes nothing', () => {
  // The same index, spelled with the document key written out. §5 makes the two spellings one
  // resource, and reconciliation has to inherit that or every explicit declaration reads as missing.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type'), desc('createdAt'), desc('__name__')],
  });
  const observed = [live('posts', [asc('type'), desc('createdAt'), desc('__name__')])];

  assert.equal(reconcile(candidate, observed).verdict, 'identical');
});

test('a __name__ whose direction is not the implicit one is meaningful and is kept on both sides', () => {
  // `[totalNbUses DESC, __name__ ASC]` occurs in real exports. §5 strips a trailing __name__ only
  // when it restates the implicit direction, and the one-sidedness has to hold symmetrically here:
  // a live index really carrying an ASC key must not match a declaration that omitted the field.
  const explicit = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [desc('totalNbUses'), asc('__name__')],
  });
  const implicit = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [desc('totalNbUses')],
  });
  const observed = [live('posts', [desc('totalNbUses'), asc('__name__')])];

  assert.equal(reconcile(explicit, observed).verdict, 'identical');
  assert.equal(reconcile(implicit, observed).verdict, 'diverged');
});

test('a declared index the target does not hold is missing, not silently tolerated', () => {
  const candidate = declare(
    { collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [asc('type'), asc('slug')] },
    { collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [asc('type'), asc('views')] },
  );
  const observed = [live('posts', [asc('type'), asc('slug'), asc('__name__')])];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'diverged');
  assert.ok(!isVouched(result));
  assert.deepEqual(
    result.missing.map((index) => index.key),
    ['posts::COLLECTION::type:ASCENDING|views:ASCENDING'],
  );
});

test('a live index no declaration covers is extra, because it makes the report read as a pass', () => {
  // The quiet failure of issue #8: the undeclared index serves a query the candidate set alone
  // would fail, so replay finds nothing and the gap never appears in the output.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type'), asc('slug')],
  });
  const observed = [
    live('posts', [asc('type'), asc('slug'), asc('__name__')]),
    live('posts', [asc('author'), desc('createdAt'), desc('__name__')], { id: 'other' }),
  ];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'diverged');
  assert.deepEqual(
    result.extra.map((entry) => entry.key),
    ['posts::COLLECTION::author:ASCENDING|createdAt:DESCENDING'],
  );
});

test('an empty candidate set against an empty listing is identical', () => {
  const result = reconcile(declare(), []);
  assert.equal(result.verdict, 'identical');
  assert.ok(isVouched(result));
});

test('the query scope is part of the identity, so the same fields under another scope do not match', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION_GROUP',
    fields: [asc('type')],
  });
  const observed = [live('posts', [asc('type'), asc('__name__')], { queryScope: 'COLLECTION' })];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'diverged');
  assert.equal(result.missing.length, 1);
  assert.equal(result.extra.length, 1);
});

test('the collection group is read out of the resource name, which is the only place it appears', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type')],
  });
  const observed = [live('comments', [asc('type'), asc('__name__')])];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'diverged');
  assert.deepEqual(
    result.extra.map((entry) => entry.key),
    ['comments::COLLECTION::type:ASCENDING'],
  );
});

test('an array field matches on CONTAINS, with the key direction read past it', () => {
  // `[isRecommended ASC, tags CONTAINS, __name__ ASC]` is a shape an export produces: the arrayConfig
  // field carries no order, so the implicit direction comes from the last field that does.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('isRecommended'), { fieldPath: 'tags', arrayConfig: 'CONTAINS' }],
  });
  const observed = [
    live('posts', [
      asc('isRecommended'),
      { fieldPath: 'tags', arrayConfig: 'CONTAINS' },
      asc('__name__'),
    ]),
  ];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'identical');
  assert.equal(result.matched[0].key, 'posts::COLLECTION::isRecommended:ASCENDING|tags:CONTAINS');
});

test('field order is part of the identity, so a permuted live index does not match', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('a'), asc('b')],
  });
  const observed = [live('posts', [asc('b'), asc('a'), asc('__name__')])];

  assert.equal(reconcile(candidate, observed).verdict, 'diverged');
});

test('two declarations that canonicalise alike collapse onto one live index rather than one going missing', () => {
  // Duplicate spellings are the linter's field-order-variant to report, not a divergence from the
  // target. Counting the second one missing would blame the database for what the file did.
  const candidate = declare(
    { collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [asc('type')] },
    { collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [asc('type'), asc('__name__')] },
  );
  const observed = [live('posts', [asc('type'), asc('__name__')])];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'identical');
  assert.equal(result.matched.length, 2);
  assert.deepEqual(result.extra, []);
});

test('separator characters in a collection id or field path cannot make two indexes match', () => {
  // The §5 key joins on `::`, `|`, and `:`, none of which these are forbidden to contain, so it is
  // not injective. Matching on it would call this pair identical — a declaration vouched for by a
  // live index that is not it, which is the one outcome reconciliation must never produce.
  // One index on a field whose name happens to contain the separators, against two ordinary fields.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [{ fieldPath: 'x:ASCENDING|y', order: 'ASCENDING' }],
  });
  const observed = [live('posts', [asc('x'), asc('y'), asc('__name__')])];

  const result = reconcile(candidate, observed);
  // Both sides really do produce the same §5 key, which is what makes this the interesting case.
  assert.equal(result.missing[0].key, 'posts::COLLECTION::x:ASCENDING|y:ASCENDING');
  assert.equal(result.extra[0].key, result.missing[0].key);
  // Matched on the key they share, this would be `identical`: a declaration vouched for by an index
  // that is not it.
  assert.equal(result.verdict, 'diverged');
  assert.deepEqual(result.matched, []);
});

test('a resource name that is not a collection group index path is unreadable, not extra', () => {
  const observed = [{ name: 'projects/p/databases/(default)', state: 'READY', queryScope: 'COLLECTION', fields: [asc('a')] }];

  const result = reconcile(declare(), observed);
  assert.equal(result.verdict, 'indeterminate');
  assert.ok(!isVouched(result));
  assert.deepEqual(result.unreadable, [
    { name: 'projects/p/databases/(default)', reason: 'name-unparseable', detail: 'projects/p/databases/(default)' },
  ]);
  assert.deepEqual(result.extra, []);
});

test('a null name is coerced rather than thrown on, and reported unreadable', () => {
  // The admin protos type `name` as `string | null`; the regular expression is about to be handed it.
  const result = reconcile(declare(), [{ name: null, state: 'READY', queryScope: 'COLLECTION', fields: [] }]);
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(result.unreadable[0].reason, 'name-unparseable');
  assert.equal(result.unreadable[0].name, 'null');
});

test('a missing query scope or fields array is unreadable rather than defaulted', () => {
  const noScope = reconcile(declare(), [{ name: named('posts'), state: 'READY', fields: [asc('a')] }]);
  assert.equal(noScope.unreadable[0].reason, 'query-scope-missing');

  const noFields = reconcile(declare(), [
    { name: named('posts'), state: 'READY', queryScope: 'COLLECTION' },
  ]);
  assert.equal(noFields.unreadable[0].reason, 'fields-missing');
});

test('a field carrying none of the three configs is refused instead of keyed as UNKNOWN', () => {
  // `fieldDirection`'s fallback is reachable from a listing, and keying on it would let two
  // different unreadable fields match each other.
  const observed = [live('posts', [asc('a'), { fieldPath: 'b' }])];

  const result = reconcile(declare(), observed);
  assert.equal(result.verdict, 'indeterminate');
  assert.deepEqual(result.unreadable, [
    { name: named('posts'), reason: 'field-unreadable', detail: 'b' },
  ]);
});

test('an apiScope this version does not compare under is unreadable, not a divergence', () => {
  // A Datastore-mode index is not a Firestore declaration the file forgot; the canonical key says
  // nothing about it. Calling it extra would manufacture a divergence that stops a correct run.
  const observed = [
    live('posts', [asc('type'), asc('__name__')], { apiScope: 'DATASTORE_MODE_API' }),
  ];

  const result = reconcile(declare(), observed);
  assert.equal(result.verdict, 'indeterminate');
  assert.deepEqual(result.unreadable, [
    { name: named('posts'), reason: 'api-scope-unrecognised', detail: 'DATASTORE_MODE_API' },
  ]);
});

test('an apiScope that is neither absent nor a comparable string is refused, not defaulted', () => {
  // Only *absent* is the ANY_API default. A value this version cannot name — the admin protos send
  // the enum as a number, and type the field nullable — must not fall through to native mode: doing
  // so vouches for a Datastore-mode index as though it were the declared Firestore one, which is a
  // false `identical` rather than a missed one.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type')],
  });
  const observed = [live('posts', [asc('type'), asc('__name__')], { apiScope: 1 })];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'indeterminate');
  assert.ok(!isVouched(result));
  assert.deepEqual(result.unreadable, [
    { name: named('posts'), reason: 'api-scope-unrecognised', detail: '1' },
  ]);

  // `null` is the nullable spelling of the same default and still compares.
  assert.equal(
    reconcile(candidate, [live('posts', [asc('type'), asc('__name__')], { apiScope: null })])
      .verdict,
    'identical',
  );
});

test('a nullish entry in the fields array is reported unreadable rather than thrown on', () => {
  // `fieldDirection` reads `.order` off its argument, so a nullish element reaches a TypeError
  // before it reaches the fallback. §3 asks `check` to decline on an entry it cannot read.
  const result = reconcile(declare(), [live('posts', [asc('a'), null])]);
  assert.equal(result.verdict, 'indeterminate');
  // `detail` reports the element that was observed — `null` — not the `undefined` that reading a
  // `fieldPath` off it would render as.
  assert.deepEqual(result.unreadable, [
    { name: named('posts'), reason: 'field-unreadable', detail: 'null' },
  ]);
});

test('a live field carrying no usable path is refused, because every one of them keys alike', () => {
  // The guard this pins is load-bearing rather than defensive, and the collision is the whole of
  // why. `IndexField` declares `fieldPath` a `string` because that is what a *declaration* carries,
  // while a live entry arrives from a service whose generated protos type it nullable — and
  // `admin.ts` conveys an entry rather than coercing one, precisely so the decision lands here.
  // Keyed instead of refused, `canonicalFields` renders a missing path as the string `undefined`, so
  // any two pathless live fields key identically and a declaration for a field genuinely named
  // `undefined` is vouched for by an index that is not it — a false `identical`, which is the one
  // verdict SPEC §3 must never reach by accident.
  const pathless = [
    { shape: { order: 'ASCENDING' }, detail: '{"order":"ASCENDING"}' },
    { shape: { fieldPath: null, order: 'ASCENDING' }, detail: '{"fieldPath":null,"order":"ASCENDING"}' },
    { shape: { fieldPath: '', order: 'ASCENDING' }, detail: '{"fieldPath":"","order":"ASCENDING"}' },
  ];

  for (const { shape, detail } of pathless) {
    const result = reconcile(declare(), [live('posts', [shape, asc('__name__')])]);
    assert.equal(result.verdict, 'indeterminate');
    // The element serialised, not `[object Object]` and not the empty string: both are what the
    // earlier `String(field?.fieldPath ?? field)` produced here, and both told an operator only that
    // some field of some index could not be read.
    assert.deepEqual(result.unreadable, [
      { name: named('posts'), reason: 'field-unreadable', detail },
    ]);
  }

  // And the collision itself, stated as the property rather than as the mechanism: two live indexes
  // whose pathless fields differ must not both be answered by one declaration. Refused, neither is
  // keyed at all, so there is nothing for a declaration to match.
  const collided = reconcile(
    declare({
      collectionGroup: 'posts',
      queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'undefined', order: 'ASCENDING' }],
    }),
    [
      live('posts', [{ order: 'ASCENDING' }, asc('__name__')], { id: 'one' }),
      live('posts', [{ order: 'DESCENDING' }, asc('__name__')], { id: 'two' }),
    ],
  );
  assert.equal(collided.verdict, 'indeterminate');
  assert.ok(!isVouched(collided));
  assert.equal(collided.unreadable.length, 2);
  assert.deepEqual(collided.matched, []);
});

test('a vector field whose dimension is not a number is refused, like an UNKNOWN direction', () => {
  // `VECTOR(?)` is `fieldDirection`'s other lossy fallback and has the same collision property:
  // every unreadable dimension keys alike. `parse.ts` validates only that `vectorConfig` is an
  // object, so a quoted dimension reaches this from a declaration as readily as from a listing —
  // and keyed on, a declared 128-dimension index would be vouched for by a live 4096-dimension one.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: '128' } }],
  });
  const observed = [live('posts', [{ fieldPath: 'embedding', vectorConfig: { dimension: '4096' } }])];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'indeterminate');
  assert.ok(!isVouched(result));
  assert.equal(result.unreadable[0].reason, 'field-unreadable');

  // A numeric dimension is read, and still distinguishes two different vector indexes.
  const numeric = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 128 } }],
  });
  assert.equal(
    reconcile(numeric, [live('posts', [{ fieldPath: 'embedding', vectorConfig: { dimension: 128 } }])])
      .verdict,
    'identical',
  );
  assert.equal(
    reconcile(numeric, [live('posts', [{ fieldPath: 'embedding', vectorConfig: { dimension: 4096 } }])])
      .verdict,
    'diverged',
  );
});

test('an absent apiScope is native-mode Firestore, because proto3 JSON omits the default', () => {
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type')],
  });
  assert.equal(
    reconcile(candidate, [live('posts', [asc('type'), asc('__name__')])]).verdict,
    'identical',
  );
  assert.equal(
    reconcile(candidate, [live('posts', [asc('type'), asc('__name__')], { apiScope: 'ANY_API' })])
      .verdict,
    'identical',
  );
});

test('an unreadable entry outranks a divergence it could otherwise be mistaken for', () => {
  // Precedence mirrors readiness.ts: an entry this version cannot read is a reason to distrust the
  // classification of everything else in the same response, so it cannot be reported as `diverged`
  // — a verdict that names a specific, fixable disagreement.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type')],
  });
  const observed = [{ name: 'nonsense', state: 'READY', queryScope: 'COLLECTION', fields: [] }];

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(result.missing.length, 1);
});

test('every outcome is sorted, so a report does not depend on listing order', () => {
  const candidate = declare(
    { collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [asc('z')] },
    { collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [asc('a')] },
  );
  const observed = [
    live('posts', [asc('y'), asc('__name__')], { id: 'y' }),
    live('posts', [asc('b'), asc('__name__')], { id: 'b' }),
  ];

  const result = reconcile(candidate, observed);
  assert.deepEqual(
    result.missing.map((index) => index.key),
    ['posts::COLLECTION::a:ASCENDING', 'posts::COLLECTION::z:ASCENDING'],
  );
  assert.deepEqual(
    result.extra.map((entry) => entry.key),
    ['posts::COLLECTION::b:ASCENDING', 'posts::COLLECTION::y:ASCENDING'],
  );
});

test('a density on either side is refused rather than matched on the key that ignores it', () => {
  // `density` decides which documents an index covers, so two indexes agreeing on collection group,
  // query scope, and fields can still serve different queries. §5's key is built from those three
  // and says nothing about it, and SPEC §4 passes it through unanalysed — so a declaration can carry
  // it and still lint clean. Matching on the key alone vouches for a DENSE live index against a
  // SPARSE_ANY declaration.
  const dense = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type')],
    density: 'SPARSE_ANY',
  });
  const declaredSide = reconcile(dense, [live('posts', [asc('type'), asc('__name__')])]);
  assert.equal(declaredSide.verdict, 'indeterminate');
  assert.ok(!isVouched(declaredSide));
  assert.equal(declaredSide.incomparable.length, 1);
  assert.equal(declaredSide.incomparable[0].reason, 'density-unrecognised');
  assert.equal(declaredSide.incomparable[0].detail, 'SPARSE_ANY');
  assert.equal(declaredSide.incomparable[0].key, 'posts::COLLECTION::type:ASCENDING');
  // Refused *before* matching: it must not also show up as a divergence it is not.
  assert.deepEqual(declaredSide.missing, []);
  assert.deepEqual(declaredSide.matched, []);

  const plain = declare({ collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [asc('type')] });
  const liveSide = reconcile(plain, [
    { ...live('posts', [asc('type'), asc('__name__')]), density: 'DENSE' },
  ]);
  assert.equal(liveSide.verdict, 'indeterminate');
  assert.deepEqual(liveSide.unreadable, [
    { name: named('posts'), reason: 'density-unrecognised', detail: 'DENSE' },
  ]);

  // Two live indexes that differ only in density are no longer one bucket the declaration can claim.
  const bothLive = reconcile(plain, [
    { ...live('posts', [asc('type'), asc('__name__')], { id: 'a' }), density: 'SPARSE_ANY' },
    { ...live('posts', [asc('type'), asc('__name__')], { id: 'b' }), density: 'DENSE' },
  ]);
  assert.equal(bothLive.verdict, 'indeterminate');
  assert.ok(!isVouched(bothLive));
  assert.equal(bothLive.unreadable.length, 2);
});

test('a declaration setting a non-native apiScope is refused, as the live side already was', () => {
  // The mirror of the live-side rule. A Datastore-mode declaration is not a Firestore index the
  // canonical key can describe, so matching it against a native-mode live index vouches for an
  // index that differs in exactly the respect the declaration went out of its way to state.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [asc('type')],
    apiScope: 'DATASTORE_MODE_API',
  });
  const result = reconcile(candidate, [
    { ...live('posts', [asc('type'), asc('__name__')]), apiScope: 'ANY_API' },
  ]);

  assert.equal(result.verdict, 'indeterminate');
  assert.ok(!isVouched(result));
  assert.equal(result.incomparable[0].reason, 'api-scope-unrecognised');
  assert.equal(result.incomparable[0].detail, 'DATASTORE_MODE_API');
  // The live index it names is not one the file failed to declare, so it must not be reported as
  // extra: a rendered report would be telling the operator to delete an index their file asks for.
  assert.deepEqual(result.extra, []);
});

test('a declared field this version cannot read is refused, not asserted to be a divergence', () => {
  // The declared half of the lossy-direction rule. `parse.ts` validates that `vectorConfig` is an
  // object, not that its dimension is a number, so this declaration is valid and lints clean.
  // Keyed on, it would land in `missing` and the live index it describes in `extra` — a confident
  // `diverged` about a field the module has just called unreadable.
  const candidate = declare({
    collectionGroup: 'posts',
    queryScope: 'COLLECTION',
    fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: '128' } }],
  });
  const result = reconcile(candidate, [
    live('posts', [{ fieldPath: 'embedding', vectorConfig: { dimension: 128 } }]),
  ]);

  assert.equal(result.verdict, 'indeterminate');
  assert.ok(!isVouched(result));
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.incomparable.map((entry) => entry.reason), ['field-unreadable']);
  assert.equal(result.incomparable[0].detail, 'embedding:VECTOR(?)');
});

test('the comparable spellings still reconcile, or check could never vouch for anything', () => {
  // The refusals must not fire on an ordinary set. SPARSE_ALL matters most here: it is the covering
  // behaviour a declaration *without* a density already asks for, so it is what §5's key assumes
  // when it says nothing — and if the Admin API stamps it on every index, refusing it would make
  // every listing indeterminate and the whole coverage check inert.
  const spellings = [
    {},
    { apiScope: 'ANY_API' },
    { density: 'DENSITY_UNSPECIFIED' },
    { density: 'SPARSE_ALL' },
    { apiScope: 'ANY_API', density: 'SPARSE_ALL' },
  ];

  for (const extras of spellings) {
    const candidate = declare({
      collectionGroup: 'posts',
      queryScope: 'COLLECTION',
      fields: [asc('type')],
      ...extras,
    });
    const result = reconcile(candidate, [
      { ...live('posts', [asc('type'), asc('__name__')]), ...extras },
    ]);

    assert.equal(result.verdict, 'identical', `refused ${JSON.stringify(extras)}`);
    assert.ok(isVouched(result));
    assert.deepEqual(result.incomparable, []);
    assert.deepEqual(result.unreadable, []);
  }

  // And a null density is the nullable spelling of absent.
  assert.equal(
    reconcile(declare({ collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [asc('type')] }), [
      { ...live('posts', [asc('type'), asc('__name__')]), density: null },
    ]).verdict,
    'identical',
  );
});

test('sorting does not fall back on the §5 key alone, which two entries can share', () => {
  // The key is the non-injective one `identity` exists to avoid relying on. Sorted by it alone, a
  // colliding pair is ordered by wherever the listing happened to put them — the dependence on
  // listing order the sort is here to remove. Same construction as the collision test above.
  const collide = [
    live('posts', [{ fieldPath: 'x:ASCENDING|y', order: 'ASCENDING' }, asc('__name__')], { id: 'a' }),
    live('posts', [asc('x'), asc('y'), asc('__name__')], { id: 'b' }),
  ];
  const order = (observed) => reconcile(declare(), observed).extra.map((entry) => entry.live.name);

  assert.equal(order(collide)[0], order([...collide].reverse())[0]);
  assert.deepEqual(order(collide), order([...collide].reverse()));

  // Two unreadable entries can share a name too — a listing really can report one resource name
  // twice — and then only the reason and the detail separate them. Both names here must *parse*,
  // or the name check short-circuits and both entries come back `name-unparseable`, which would
  // hold in either order with no tie-breaker at all.
  const unreadable = [
    { name: named('posts'), state: 'READY', fields: [asc('a')] }, // query-scope-missing
    { name: named('posts'), state: 'READY', queryScope: 'COLLECTION' }, // fields-missing
  ];
  const reasons = (observed) => reconcile(declare(), observed).unreadable.map((e) => e.reason);
  assert.deepEqual(reasons(unreadable), ['fields-missing', 'query-scope-missing']);
  assert.deepEqual(reasons(unreadable), reasons([...unreadable].reverse()));
});

test('the unreadable reasons are the ones the module can actually produce', () => {
  // Keeps the exported vocabulary and the code from drifting apart, the way SPEC §7's closed
  // operator vocabulary is pinned.
  assert.deepEqual([...UNREADABLE_REASONS].sort(), [
    'api-scope-unrecognised',
    'density-unrecognised',
    'field-unreadable',
    'fields-missing',
    'name-unparseable',
    'query-scope-missing',
  ]);
  assert.deepEqual([...INCOMPARABLE_REASONS].sort(), [
    'api-scope-unrecognised',
    'density-unrecognised',
    'field-unreadable',
  ]);
});

/**
 * Every test above builds its listing by hand, which is the gap issue #20 names: a module whose job
 * is reading the Admin API cannot check its reading against a listing its own author wrote. These
 * run against one a real database returned.
 */
// Not `observed`: that name is a local in most of the tests above, and a module-scope binding it
// shadows is a trap for the next test written by pattern-matching them.
const liveFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('fixtures/live-indexes.json', import.meta.url)), 'utf8'),
);

test('the file firebase generates reconciles against the database it was generated from', () => {
  // The round trip an adopter actually performs: `firebase firestore:indexes` writes the candidate
  // file, and `check` reconciles it against the same target. If that does not come back vouched,
  // nothing else about the verb matters. It carries `density: SPARSE_ALL`, which is not incidental —
  // the CLI round-trips density, so every generated file has one.
  const candidate = analyse({ indexes: [liveFixture.declarationByFirebaseCli] });
  const result = reconcile(candidate, [liveFixture.liveByAdminClient]);

  // Both buckets in the diagnostic, because the density this test turns on is carried by *both*
  // sides: a refused declaration lands in `incomparable` and a refused listing in `unreadable`, and
  // reporting only one of them points a maintainer at an empty list.
  const refused = JSON.stringify({ unreadable: result.unreadable, incomparable: result.incomparable });
  assert.equal(result.verdict, 'identical', refused);
  assert.ok(isVouched(result));
  assert.deepEqual(result.unreadable, []);
  assert.deepEqual(result.incomparable, []);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].key, 'probe::COLLECTION::x:ASCENDING|z:ASCENDING');
});

test('a real listing is readable, whichever tool rendered it', () => {
  // The two renderings differ in what they leave out: only the admin client fills in the fields
  // holding their proto3 default, so `apiScope` is present in one and absent in the other. Both have
  // to read, which is what `comparableUnder` treating absent as comparable buys.
  //
  // The asymmetry is asserted rather than assumed. It is the whole point of the test, and the
  // fixture is meant to be re-observed — against a `gcloud` that filled the defaults in, both
  // iterations would exercise the present-`apiScope` path, the absent one would go uncovered, and
  // this test would still pass while covering half of what it names.
  //
  // Absence, not nullishness: `assert.equal` would accept a `null` here, and "gcloud omits it" is
  // the claim. `comparableUnder` treats the two alike, so this pins the observation rather than the
  // code path — which is the half that can drift when the file is regenerated.
  assert.strictEqual(liveFixture.liveByAdminClient.apiScope, 'ANY_API');
  assert.ok(!('apiScope' in liveFixture.liveByGcloud));

  const candidate = analyse({ indexes: [liveFixture.declarationByFirebaseCli] });
  for (const rendering of ['liveByAdminClient', 'liveByGcloud']) {
    const result = reconcile(candidate, [liveFixture[rendering]]);
    assert.equal(result.verdict, 'identical', `${rendering}: ${JSON.stringify(result.unreadable)}`);
  }
});

test('the density a database actually stamps is one this version compares under', () => {
  // The load-bearing half of #20. `SPARSE_ALL` is not a value that merely might turn up: an index
  // created with no density comes back with it, and so does one created with DENSITY_UNSPECIFIED —
  // the API normalises rather than echoing. Had `COMPARABLE_DENSITIES` excluded it, every live entry
  // would be `density-unrecognised`, every reconciliation `indeterminate`, and `check` unable to
  // vouch for anything — while this suite stayed green on its hand-written listings.
  assert.equal(liveFixture.liveByAdminClient.density, 'SPARSE_ALL');
  const result = reconcile(analyse({ indexes: [] }), [liveFixture.liveByAdminClient]);
  assert.deepEqual(result.unreadable, []);
  // Undeclared rather than unreadable: the entry was read, and it is a divergence from an empty
  // candidate set rather than something the module declined to interpret.
  assert.equal(result.extra.length, 1);
});

test('the fields a live index carries beyond SPEC §5 arrive at their defaults', () => {
  // Half of why the hole below does not bite on the database this was observed against: all three
  // come back at their defaults, so nothing in the recorded listing reaches it. This much really is
  // a pin on the fixture rather than on the module — it fails when the file is regenerated against
  // a database that answers differently, which is the only way an observation can change.
  assert.equal(liveFixture.liveByAdminClient.unique, false);
  assert.equal(liveFixture.liveByAdminClient.multikey, false);
  assert.equal(liveFixture.liveByAdminClient.shardCount, 0);
});

test('a field beyond SPEC §5 is vouched for from either side, which is the open hole', () => {
  // The other half, and it is asserted against `reconcile` rather than against the fixture:
  // `unique`, `multikey` and `shardCount` are invisible to §5's key, so an index setting one is
  // matched on a key that cannot see it — the same false vouch the `density` refusal exists to
  // prevent, arriving by a route nothing refuses. The three assertions above cannot catch that; only
  // feeding the module a contrary set can, and this is that.
  //
  // Both directions, because refusing only one side would be half a guard — the reason
  // `INCOMPARABLE_REASONS` exists at all. `density` is refused on the live side by `readLive` and on
  // the declared side by `incomparableReason`; these three are refused by neither, so the false
  // vouch runs both ways: a non-unique declaration is vouched for by a `unique` live index, and a
  // declaration that went out of its way to ask for `unique` is vouched for by a live index that is
  // not one. SPEC §4 keeps unknown keys, so the declared direction is reachable from any
  // `firestore.indexes.json` that names them.
  //
  // So the expectation here is deliberately the *wrong* answer: `identical`, both ways. It is
  // pinned rather than fixed because refusing the three needs observations issue #20 could not
  // reach, and pinned rather than left undocumented so that closing the hole announces itself as a
  // failure here instead of passing silently — on whichever side it gets closed first.
  const declared = {
    collectionGroup: 'probe',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'x', order: 'ASCENDING' },
      { fieldPath: 'z', order: 'ASCENDING' },
    ],
  };

  for (const beyond of [{ unique: true }, { multikey: true }, { shardCount: 7 }]) {
    const what = JSON.stringify(beyond);

    // Set on the live side, absent from the declaration.
    const live = reconcile(analyse({ indexes: [declared] }), [
      { ...liveFixture.liveByAdminClient, ...beyond },
    ]);
    assert.equal(live.verdict, 'identical', `live ${what}`);
    assert.ok(isVouched(live), `live ${what}`);
    assert.deepEqual(live.unreadable, [], `live ${what}`);

    // Set on the declaration, absent from the live index — the mirror, and the one a live-side-only
    // refusal would leave behind.
    const decl = reconcile(analyse({ indexes: [{ ...declared, ...beyond }] }), [
      liveFixture.liveByAdminClient,
    ]);
    assert.equal(decl.verdict, 'identical', `declared ${what}`);
    assert.ok(isVouched(decl), `declared ${what}`);
    assert.deepEqual(decl.incomparable, [], `declared ${what}`);
  }
});
