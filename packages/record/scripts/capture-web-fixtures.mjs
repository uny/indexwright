#!/usr/bin/env node
/**
 * Regenerate `test/fixtures/web-sdk.json`: the HTTP/1.1 request bodies the Firebase Web SDK sends
 * for a query, as the SDK itself emits them (issue #58).
 *
 * Two transports, both captured here. The full SDK's browser build sends a `ListenRequest` as JSON
 * inside a WebChannel forward-channel POST, and does so for `getDocs` as much as for `onSnapshot`;
 * `firebase/firestore/lite` posts a `RunQueryRequest` as JSON to the REST `documents:runQuery`
 * endpoint. The reader in `decode-json.ts` handles a wire format this project does not own, and the
 * failure mode that matters is a key name that is quietly wrong — `field_path` for `fieldPath` —
 * which parses cleanly and yields a tree with no names in it. Fixtures taken from the real client
 * are what catch that.
 *
 * There is no emulator here and no Java. The browser build runs under Node, and both clients talk
 * to a stub that answers with nothing: the request is on the wire before any answer is due, and
 * that is all the fixture needs.
 *
 * Run by hand, not in CI, and only when the case list below changes:
 *
 *     npm install --no-save firebase
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
  console.error('this script needs firebase:\n  npm install --no-save firebase');
  process.exit(2);
};
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
    // gets a result it can use, and neither needs one.
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': '*',
    });
    response.end();
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
process.exit(0);
