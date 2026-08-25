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

test('a failure the service worded is rendered, not reprinted, and a non-Error still says something', async () => {
  // The one string on this stream the local machine did not author. A run that has just been pointed
  // at an unexpected service is exactly when the reply is chosen by whoever answered, so a status
  // carrying a newline would forge the line naming the target — the harm `render` exists to prevent,
  // applied to the value that arrives from furthest away.
  const forging = {
    listIndexesAsync() {
      return (async function* () {
        throw new Error('denied\nindexwright-record: target projects/decoy/databases/(default)');
      })();
    },
  };
  await assert.rejects(() => listLiveIndexes(TARGET, forging), (error) => {
    assert.match(error.message, /"denied\\u000aindexwright-record: target projects\/decoy/);
    // The forged line is text inside a rendered value; it cannot start a line of its own.
    assert.doesNotMatch(error.message, /\n/);
    return true;
  });

  // A rejection that is not an `Error` at all — a plain object or a string off a transport that did
  // not wrap it. `messageOf`'s other branch: without it the message ends `: undefined`, naming no
  // cause on the one path SPEC §3 asks to explain why readiness could not be established.
  const bare = {
    listIndexesAsync() {
      return (async function* () {
        // eslint-disable-next-line no-throw-literal
        throw 'connection reset';
      })();
    },
  };
  await assert.rejects(() => listLiveIndexes(TARGET, bare), (error) => {
    assert.ok(error instanceof AdminError);
    assert.match(error.message, /"connection reset"/);
    assert.doesNotMatch(error.message, /undefined/);
    return true;
  });
});

/**
 * A rejection the handler cannot describe still leaves as an `AdminError`.
 *
 * Its own test rather than a fourth block appended to the one above, because these run in sequence
 * inside a single `test()` and the first assertion to fail ends the function: a regression in
 * `render` would take the coverage below it with it, and report one failure where there were two.
 * The property here is also a different one — not that the message is worded or rendered, but that
 * composing it cannot throw.
 */
test('a rejection with no route to a primitive still declines, and says what it can', async () => {
  const rejecting = (value) => ({
    listIndexesAsync() {
      return (async function* () {
        throw value;
      })();
    },
  });

  const declines = async (lister, detail) => {
    await assert.rejects(() => listLiveIndexes(TARGET, lister), (error) => {
      assert.ok(error instanceof AdminError);
      assert.match(error.message, /could not list the indexes of projects\/indexwright-probe/);
      assert.match(error.message, detail);
      return true;
    });
  };

  // No prototype, so no `toString`: `String()` on it throws `Cannot convert object to primitive
  // value` — from inside the very catch block whose promise is that a failure leaves as an
  // `AdminError` rather than as a listing. Thrown there, it would replace that `AdminError` with a
  // `TypeError` naming neither the parent nor the cause, which is the failure this whole path
  // exists to prevent wearing its own handler's clothes.
  await declines(rejecting(Object.create(null)), /\[object Object\]/);

  // The same hole one level down. `Object.prototype.toString` is what the line above falls back to,
  // and it is not the total function an earlier comment here claimed: it looks up
  // `Symbol.toStringTag`, so a getter that throws defeats the fallback exactly as a throwing
  // `Symbol.toPrimitive` defeats `String`. Without the nested catch this rejects with `boom`.
  const untaggable = Object.create(null);
  Object.defineProperty(untaggable, Symbol.toStringTag, {
    get() {
      throw new Error('boom');
    },
  });
  await declines(rejecting(untaggable), /\[unprintable rejection\]/);

  // An `Error` whose `message` is not a string. `render` iterates its argument, so returning the
  // number raw threw `value is not iterable` out of the handler — the same death, reached through
  // the branch that looks the safest. `Object.assign` over a real `Error` is not exotic for
  // something that crossed a transport.
  await declines(rejecting(Object.assign(new Error('ignored'), { message: 7 })), /"7"/);

  // And an `Error` whose `message` is a throwing getter, which is the second route into the catch:
  // the read itself fails, before any coercion. The instance is still an `Error`, so the fallback
  // can name that much.
  const unreadable = new Error('ignored');
  Object.defineProperty(unreadable, 'message', {
    get() {
      throw new TypeError('boom');
    },
  });
  await declines(rejecting(unreadable), /\[object Error\]/);
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

/**
 * Run `body` with `process.env` set as described, and restore it afterwards whatever happens.
 *
 * `adminLister` reads `process.env` rather than an injected environment, because that is what the
 * client reads and a guard that consults a different source can disagree with the thing it guards.
 * The cost is here: these tests mutate the real environment, so they restore it in a `finally` and
 * delete keys that were absent rather than setting them back to `undefined` — which would leave the
 * string `"undefined"` behind and make the next test's guard fire on it.
 */
async function withEnv(overrides, body) {
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NO_REDIRECTS = { FIRESTORE_EMULATOR_HOST: undefined, GOOGLE_CLOUD_UNIVERSE_DOMAIN: undefined };

test('the client is refused while a redirect variable is set, and is named for the target', async () => {
  // Issue #37, at the layer below the one that reports it. `parseCheck` is where an operator meets
  // this, and the JavaScript API is public — a caller reaching the adapter directly with a variable
  // exported would otherwise get the silent redirect the refusal exists to prevent.
  await withEnv({ ...NO_REDIRECTS, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, async () => {
    await assert.rejects(() => adminLister('acme-prod'), (error) => {
      assert.ok(error instanceof AdminError);
      assert.match(error.message, /FIRESTORE_EMULATOR_HOST is set to "127\.0\.0\.1:8080"/);
      return true;
    });
  });

  // The second redirect, and the one the first version of this module missed: the admin client does
  // not read the emulator variable at all, it reads this one, and turns it into `firestore.{value}`
  // as the service path. Nothing downstream notices — gax validates a universe domain it was never
  // handed — so the listing arrives from another service under the announced target's name.
  await withEnv({ ...NO_REDIRECTS, GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'other.example' }, async () => {
    await assert.rejects(() => adminLister('acme-prod'), (error) => {
      assert.ok(error instanceof AdminError);
      assert.match(error.message, /GOOGLE_CLOUD_UNIVERSE_DOMAIN is set to "other\.example"/);
      return true;
    });
  });

  // The guard reads `process.env` and nothing else. Pinned because the bug it replaces was exactly
  // an argument that let a caller answer the question on the client's behalf: with an `env`
  // parameter, `adminLister('acme-prod', {})` passed while the ambient variable redirected the
  // client it then built. There is no second source to disagree with any more, and this fails if
  // one is reintroduced.
  await withEnv({ ...NO_REDIRECTS, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, async () => {
    await assert.rejects(() => adminLister('acme-prod', {}), AdminError);
  });
});

test('the constructed client is bound to the named project, and is a real admin client', async () => {
  // Unset and set-to-nothing are the same thing to a client that tests the emulator variable for
  // truthiness, so they are the same thing here.
  await withEnv({ ...NO_REDIRECTS, FIRESTORE_EMULATOR_HOST: '' }, async () => {
    const lister = await adminLister('acme-prod');
    assert.equal(typeof lister.listIndexesAsync, 'function');

    // `project` is a parameter and previously nothing observed it: drop the `{ projectId }`
    // argument and every assertion above still held, while the client fell back to discovering a
    // project from `GOOGLE_CLOUD_PROJECT`, a `gcloud` default, or the credentials in use.
    //
    // What that would *not* do is change which database is listed, and this assertion should not be
    // read as claiming otherwise. `listIndexesAsync` sends the `parent` it is given verbatim and
    // derives its routing header from that same string, so the resource is decided by the target the
    // operator named and by nothing else — which is where issue #8's guarantee actually lives, and
    // is why `adminLister`'s own comment says passing this "changes no request". What a discovered
    // project would change is quieter: the run would authenticate and attribute quota under a
    // project nobody named, so a failure would be reported against the wrong one. Passed explicitly
    // so that ambient state decides nothing here either, and pinned so the parameter cannot quietly
    // become inert. `_opts` is internal, and is read anyway: it is where the constructor puts this,
    // and an assertion that cannot see the value cannot pin it.
    assert.equal(lister._opts.projectId, 'acme-prod');

    // Also pins the interop the types are wrong about: the runtime namespace carries `v1` under
    // `default`, so a client constructed the way the types describe would be a `TypeError` here
    // rather than a compile error anywhere.
    assert.equal(lister.constructor.name, 'FirestoreAdminClient');
  });
});
