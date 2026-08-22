import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyse } from 'indexwright';
import {
  adminLister,
  AdminError,
  indexesParent,
  listLiveIndexes,
  reconcile,
  ReadinessGate,
} from '../dist/index.js';

const TARGET = 'projects/indexwright-probe/databases/(default)';

/** A lister that yields what it was given, the way `listIndexesAsync` does. */
function lists(...indexes) {
  const seen = [];
  return {
    seen,
    listIndexesAsync(request, options) {
      seen.push({ request, options });
      return (async function* () {
        for (const index of indexes) yield index;
      })();
    },
  };
}

test('the listing is asked for across every collection group, under the announced target', async () => {
  // The wildcard is the whole of it: an index on a group the corpus never queries is still part of
  // the set `reconcile` compares, so listing group by group would make the observed set a function
  // of the corpus and report a divergence there as agreement.
  assert.equal(indexesParent(TARGET), `${TARGET}/collectionGroups/-`);

  const lister = lists();
  await listLiveIndexes(TARGET, lister);
  // The target is threaded through as the string the run announced, rather than reassembled from a
  // project and a database here: the line an operator is asked to trust and the resource actually
  // listed are then the same string by construction.
  //
  // `autoPaginate: false` is asserted because it is the value `asyncIterate` forces anyway — it does
  // not turn paging off, it stops gax printing an `AutopaginateTrueWarning` beside the target line
  // on every run. Dropped, the paging would be identical and the noise would come back unnoticed.
  assert.deepEqual(lister.seen, [
    { request: { parent: `${TARGET}/collectionGroups/-` }, options: { autoPaginate: false } },
  ]);
});

test('entries are conveyed rather than classified, including ones this version cannot read', async () => {
  // The adapter is the one module with no way to report a verdict, so it decides nothing. A state it
  // does not know, an enum arriving as a number, a null name: all reach the modules whose job it is
  // to decline on them. Coercing here is what would turn a decline into a guess.
  const odd = [
    { name: 'projects/p/databases/d/collectionGroups/c/indexes/i', state: 'DEFRAGMENTING' },
    { name: null, state: 2, queryScope: 1, fields: null },
  ];
  const observed = await listLiveIndexes(TARGET, lists(...odd));
  assert.deepEqual(observed, odd);

  // And the declining still happens, one module along.
  const readiness = new ReadinessGate(0).observe(observed, 0);
  assert.equal(readiness.kind, 'unrecognised');
  assert.deepEqual(readiness.states, ['2', 'DEFRAGMENTING']);
  assert.equal(reconcile([], observed).verdict, 'indeterminate');
});

test('a listing a real database returned reconciles as itself', async () => {
  // The fixture is the one primary source for what the Admin API sends (issue #20). Put through the
  // adapter it has to arrive as something `reconcile` reads, or the pass-through is passing the
  // wrong thing through: the entry the client yields is the entry the fixture recorded.
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/live-indexes.json', import.meta.url)), 'utf8'),
  );
  const observed = await listLiveIndexes(TARGET, lists(fixture.liveByAdminClient));
  const candidate = analyse({ indexes: [fixture.declarationByFirebaseCli] });

  const result = reconcile(candidate, observed);
  assert.equal(result.verdict, 'identical');
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].key, 'probe::COLLECTION::x:ASCENDING|z:ASCENDING');
  assert.equal(new ReadinessGate(0).observe(observed, 0).kind, 'settling');
});

test('an empty listing is a listing, and a failed one is never an empty listing', async () => {
  // The distinction the rest of `check` cannot make for itself. `[]` means "observed, and empty",
  // which `ReadinessGate.observe` reads as a database with nothing left to build and `reconcile`
  // reads as every declaration missing — so a failure that arrived as `[]` would report a confident
  // divergence about a database nobody managed to look at.
  assert.deepEqual(await listLiveIndexes(TARGET, lists()), []);

  const denied = Object.assign(new Error('Missing or insufficient permissions.'), { code: 7 });
  const failing = {
    listIndexesAsync() {
      return (async function* () {
        throw denied;
      })();
    },
  };
  await assert.rejects(() => listLiveIndexes(TARGET, failing), (error) => {
    assert.ok(error instanceof AdminError);
    // The parent is named, because a permission error on a listing does not otherwise say which
    // database the principal was refused on.
    assert.match(error.message, /could not list the indexes of projects\/indexwright-probe/);
    assert.match(error.message, /Missing or insufficient permissions/);
    // Kept, so a caller can still reach the gRPC status the client set on it.
    assert.equal(error.cause, denied);
    return true;
  });
});

test('a listing that fails part way through is not the part that arrived', async () => {
  // The failure mode auto-pagination exists to prevent, and the one worth pinning: entries already
  // yielded are discarded rather than returned as the set. A page one that arrived and a page two
  // that did not is a *partial* listing, and partial reports the rest of the target's indexes as
  // missing — SPEC §3's false divergence, arriving from the module that promised not to produce one.
  const truncated = {
    listIndexesAsync() {
      return (async function* () {
        yield { name: 'projects/p/databases/d/collectionGroups/c/indexes/first', state: 'READY' };
        throw new Error('Deadline exceeded');
      })();
    },
  };
  await assert.rejects(() => listLiveIndexes(TARGET, truncated), AdminError);
});

test('the client is refused while the emulator variable is set, and is named for the target', async () => {
  // Issue #37, at the layer below the one that reports it. `parseCheck` is where an operator meets
  // this, and the JavaScript API is public — a caller reaching the adapter directly with the
  // variable exported would otherwise get the silent redirect the refusal exists to prevent.
  await assert.rejects(
    () => adminLister('acme-prod', { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }),
    (error) => {
      assert.ok(error instanceof AdminError);
      assert.match(error.message, /FIRESTORE_EMULATOR_HOST is set to "127\.0\.0\.1:8080"/);
      return true;
    },
  );

  // Unset and set-to-nothing are the same thing to a client that tests it for truthiness, so they
  // are the same thing here. This also pins the interop the types are wrong about: the runtime
  // namespace carries `v1` under `default`, so a client constructed the way the types describe
  // would be a `TypeError` here rather than a compile error anywhere.
  const lister = await adminLister('acme-prod', { FIRESTORE_EMULATOR_HOST: '' });
  assert.equal(typeof lister.listIndexesAsync, 'function');
});
