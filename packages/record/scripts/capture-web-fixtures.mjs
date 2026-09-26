#!/usr/bin/env node
/**
 * Regenerate `test/fixtures/web-sdk.json` and `test/fixtures/web-sdk-aggregation.json`: the
 * HTTP/1.1 request bodies the Firebase Web SDK sends for a query and for an aggregation, as the
 * SDK itself emits them (issue #58; aggregation, issue #93).
 *
 * Two transports for a plain query, both captured into `web-sdk.json`. The full SDK's browser
 * build sends a `ListenRequest` as JSON inside a WebChannel forward-channel POST, and does so for
 * `getDocs` as much as for `onSnapshot`; `firebase/firestore/lite` posts a `RunQueryRequest` as
 * JSON to the REST `documents:runQuery` endpoint. The reader in `decode-json.ts` handles a wire
 * format this project does not own, and the failure mode that matters is a key name that is quietly
 * wrong — `field_path` for `fieldPath` — which parses cleanly and yields a tree with no names in
 * it. Fixtures taken from the real client are what catch that.
 *
 * **`count()`/`sum()`/`average()` are not a third transport — they are the *same* REST transport
 * the full SDK's plain queries never use.** `RestConnection`, in `@firebase/firestore`'s shared
 * internals, routes every non-streaming RPC (`BatchGetDocuments`, `Commit`, `RunAggregationQuery`)
 * through a plain HTTP/1.1 POST rather than through the WebChannel `Listen` stream a `Query` goes
 * out on; `WebChannelConnection` extends it rather than replacing it, and only overrides the
 * streaming half. `getCountFromServer`/`getAggregateFromServer` (full SDK) and
 * `getCount`/`getAggregate` (`firestore/lite`) both reach `invokeRunAggregationQueryRpc`, which
 * calls that non-streaming path — so the full SDK's aggregation and lite's aggregation are the
 * *same* REST call, `documents:runAggregationQuery`, with no forward-channel body to capture at
 * all. `web-sdk-aggregation.json` captures both anyway, because "the same call" is exactly the kind
 * of claim a wire capture should confirm rather than assume — the two SDKs share a serializer but
 * not a build, and a divergence would be silent otherwise.
 *
 * There is no emulator here and no Java. The browser build runs under Node, and both clients talk
 * to a stub that answers with an empty JSON array — enough for a preflight to pass and for a
 * streamed-response client to parse the reply as "no rows" rather than fail to parse it at all; the
 * request is on the wire before any answer is due either way, and that is all either fixture needs.
 *
 * **The aggregation half needs one more thing the plain-query half does not: `XMLHttpRequest`.**
 * `RestConnection`'s non-streaming invoke — the path `RunAggregationQuery` takes, see above — goes
 * through `@firebase/webchannel-wrapper`'s `XhrIo`, which calls the real, global `XMLHttpRequest`
 * unconditionally; there is no `fetch` fallback the way the WebChannel *streaming* half the plain
 * query capture already exercises seems to tolerate running without one. Node has no such global,
 * so without a polyfill the call fails before a byte reaches the stub — silently enough that the
 * SDK's own error object serialises to `{}` and gives no hint what went wrong. `xhr2` supplies it.
 * And an empty response body specifically breaks `XhrIo`'s `JSON.parse` *inside an XHR event
 * callback* rather than inside a promise chain, which is not a rejection this script's `.catch`
 * handlers can reach — it is why the response below is `'[]'` and not empty, for every request this
 * stub answers, not only the aggregation ones.
 *
 * Run by hand, not in CI, and only when a case list below changes:
 *
 *     npm install --no-save firebase xhr2
 *     node packages/record/scripts/capture-web-fixtures.mjs
 *
 * The expected shapes are asserted in `test/decode-json.test.js` and are written by hand there.
 * Nothing in this script decides what a case *should* decode to; it only records what the client sent.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const missing = () => {
  console.error('this script needs firebase and xhr2:\n  npm install --no-save firebase xhr2');
  process.exit(2);
};
// Installed before anything from `firebase` is imported: `RestConnection`'s non-streaming invoke
// reads the global at call time, not at module load, but there is no path in this script that
// calls it before this line runs either way, so the order here is the simplest one that works.
globalThis.XMLHttpRequest = (await import('xhr2').catch(missing)).default;
const { initializeApp } = await import('firebase/app').catch(missing);
// The `browser` build by path, past the package's `exports`: Node resolves the package to its gRPC
// build, which is the transport the proxy already reads.
const packageJson = createRequire(import.meta.url).resolve('@firebase/firestore/package.json');
const browserBuild = new URL('dist/index.esm.js', pathToFileURL(packageJson));
const web = await import(browserBuild.href).catch(missing);
const lite = await import('firebase/firestore/lite').catch(missing);

/**
 * Each case names a query the way an application would write it, against whichever module it is
 * handed — the full SDK and lite share the query-builder API.
 */
const CASES = [
  ['equality and inequality with two sorts', (f, c) =>
    f.query(c('orders'), f.where('status', '==', 'open'), f.where('amount', '>', 1),
      f.orderBy('amount', 'desc'), f.orderBy('createdAt', 'asc'), f.limit(10))],
  ['a collection group query', (f, c, g) =>
    f.query(g('items'), f.where('sku', '==', 'x'), f.orderBy('qty'))],
  ['no filters and no sort', (f, c) => f.query(c('orders'))],
  ['a disjunction nested under a conjunction', (f, c) =>
    f.query(c('orders'), f.and(
      f.or(f.where('tier', '==', 'a'), f.where('tier', '==', 'b')),
      f.where('tags', 'array-contains', 'sale')))],
  ['every field operator', (f, c) =>
    f.query(c('orders'),
      f.where('a', '<', 1), f.where('b', '<=', 1), f.where('c', '>', 1), f.where('d', '>=', 1),
      f.where('e', '==', 1), f.where('f', 'array-contains', 1),
      f.where('g', 'in', [1]), f.where('h', 'array-contains-any', [1]))],
  ['a not-equal filter', (f, c) => f.query(c('orders'), f.where('state', '!=', 'void'))],
  ['a not-in filter', (f, c) => f.query(c('orders'), f.where('state', 'not-in', ['void']))],
  ['null and NaN, which reach the wire as unary filters', (f, c) =>
    f.query(c('orders'), f.where('deletedAt', '==', null), f.where('score', '==', Number.NaN))],
  // One per query: the Web SDK refuses two `!=` filters client-side, where the server SDK sends them.
  ['not-null', (f, c) => f.query(c('orders'), f.where('deletedAt', '!=', null))],
  ['not-NaN', (f, c) => f.query(c('orders'), f.where('score', '!=', Number.NaN))],
  ['a sort on the document key', (f, c) =>
    f.query(c('orders'), f.orderBy(f.documentId(), 'desc'))],
  ['a field path that holds the key delimiters', (f, c) =>
    f.query(c('orders'), f.where(new f.FieldPath('weird:path|with(parens)'), '==', 1))],
  ['a nested field path', (f, c) => f.query(c('orders'), f.where('profile.city', '==', 'kyoto'))],
];

/**
 * Each aggregation case names a query and how to aggregate it. `spec` is `null` for a bare count —
 * `getCountFromServer`/`getCount` take no spec at all, and are a different call from
 * `getAggregateFromServer`/`getAggregate` with a `{ count() }` spec, so a bare count is captured as
 * the call an application actually writes rather than as the general case's degenerate spelling.
 */
const AGGREGATION_CASES = [
  ['a bare count', (f, c) => ({ query: f.query(c('orders')) })],
  ['sum and average together', (f, c) => ({
    query: f.query(c('orders')),
    spec: { total: f.sum('amount'), mean: f.average('amount') },
  })],
  ['a count over a filtered collection-group query', (f, c, g) => ({
    query: f.query(g('items'), f.where('sku', '==', 'x')),
  })],
];

/** Every POST body the stub received, with the path it arrived on. */
const captured = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    if (request.method === 'POST') {
      captured.push({
        path: request.url,
        contentType: request.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
    }
    // Enough for a preflight to pass and for a request to be considered answered. Neither client
    // gets a result it can use, and neither needs one — but the body has to be valid JSON naming no
    // rows rather than empty: see the module docblock on why an empty body crashes the aggregation
    // capture specifically, from inside an XHR event callback rather than as an ordinary rejection.
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': '*',
      'content-type': 'application/json',
    });
    response.end('[]');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

/** Wait for the next POST on `pathPart`, which the client sends without waiting for an answer. */
function nextRequest(pathPart) {
  const before = captured.length;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`no POST to ${pathPart} within 5s`)), 5000);
    const poll = setInterval(() => {
      const found = captured.slice(before).find((entry) => entry.path.includes(pathPart));
      if (found === undefined) return;
      clearTimeout(deadline);
      clearInterval(poll);
      resolve(found);
    }, 10);
  });
}

const cases = [];
let n = 0;
for (const [name, build] of CASES) {
  // A fresh app per case, so each one opens its own channel and the first forward-channel POST —
  // the one that carries the target — is unambiguous.
  const app = initializeApp({ projectId: 'demo-fixtures' }, `case-${n++}`);

  const webDb = web.getFirestore(app);
  web.connectFirestoreEmulator(webDb, '127.0.0.1', port);
  const listen = nextRequest('/google.firestore.v1.Firestore/Listen/channel');
  web.getDocs(build(web, (id) => web.collection(webDb, id), (id) => web.collectionGroup(webDb, id))).catch(() => {});
  const forwardChannel = await listen;
  await web.terminate(webDb).catch(() => {});

  const liteDb = lite.getFirestore(app);
  lite.connectFirestoreEmulator(liteDb, '127.0.0.1', port);
  const run = nextRequest(':runQuery');
  lite.getDocs(build(lite, (id) => lite.collection(liteDb, id), (id) => lite.collectionGroup(liteDb, id))).catch(() => {});
  const rest = await run;

  cases.push({
    name,
    forwardChannel: { contentType: forwardChannel.contentType, body: forwardChannel.body },
    rest: { path: rest.path, contentType: rest.contentType, body: rest.body },
  });
}
const aggregationCases = [];
for (const [name, build] of AGGREGATION_CASES) {
  // A fresh app per case, for the reason the plain-query loop above uses one: it keeps this case's
  // capture unambiguous from the one before it, though there is no forward-channel target here to
  // disambiguate — both aggregation calls are one-shot REST POSTs, not a stream that could carry
  // more than one thing.
  const app = initializeApp({ projectId: 'demo-fixtures' }, `agg-case-${n++}`);

  const webDb = web.getFirestore(app);
  web.connectFirestoreEmulator(webDb, '127.0.0.1', port);
  const { query: webQuery, spec: webSpec } = build(
    web,
    (id) => web.collection(webDb, id),
    (id) => web.collectionGroup(webDb, id),
  );
  const full = nextRequest(':runAggregationQuery');
  (webSpec === undefined ? web.getCountFromServer(webQuery) : web.getAggregateFromServer(webQuery, webSpec)).catch(
    () => {},
  );
  const fullRequest = await full;
  await web.terminate(webDb).catch(() => {});

  const liteDb = lite.getFirestore(app);
  lite.connectFirestoreEmulator(liteDb, '127.0.0.1', port);
  const { query: liteQuery, spec: liteSpec } = build(
    lite,
    (id) => lite.collection(liteDb, id),
    (id) => lite.collectionGroup(liteDb, id),
  );
  const liteRun = nextRequest(':runAggregationQuery');
  (liteSpec === undefined ? lite.getCount(liteQuery) : lite.getAggregate(liteQuery, liteSpec)).catch(() => {});
  const liteRequest = await liteRun;

  aggregationCases.push({
    name,
    full: { path: fullRequest.path, contentType: fullRequest.contentType, body: fullRequest.body },
    lite: { path: liteRequest.path, contentType: liteRequest.contentType, body: liteRequest.body },
  });
}
await new Promise((resolve) => server.close(resolve));

const out = fileURLToPath(new URL('../test/fixtures/web-sdk.json', import.meta.url));
writeFileSync(
  out,
  `${JSON.stringify(
    {
      note:
        'HTTP/1.1 request bodies as the Firebase Web SDK sends them: a WebChannel forward-channel ' +
        'POST from the browser build of @firebase/firestore, and a REST documents:runQuery from ' +
        'firebase/firestore/lite. Regenerate with packages/record/scripts/capture-web-fixtures.mjs. ' +
        'The shape each one is expected to decode to is written by hand in test/decode-json.test.js.',
      cases,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${cases.length} cases to ${out}`);

const aggregationOut = fileURLToPath(new URL('../test/fixtures/web-sdk-aggregation.json', import.meta.url));
writeFileSync(
  aggregationOut,
  `${JSON.stringify(
    {
      note:
        'REST documents:runAggregationQuery bodies as the Firebase Web SDK sends them (issue #93) ' +
        '— from both the full SDK (getCountFromServer/getAggregateFromServer) and ' +
        'firebase/firestore/lite (getCount/getAggregate), which this capture confirms send the ' +
        'same call rather than merely being assumed to. There is no forward-channel form: ' +
        'RestConnection routes RunAggregationQuery over plain HTTP/1.1 for both SDKs, never over ' +
        'WebChannel. Regenerate with packages/record/scripts/capture-web-fixtures.mjs. The shape ' +
        'each one is expected to decode to is written by hand in test/decode-json.test.js.',
      cases: aggregationCases,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${aggregationCases.length} aggregation cases to ${aggregationOut}`);
process.exit(0);
