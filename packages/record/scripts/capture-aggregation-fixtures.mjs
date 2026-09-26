#!/usr/bin/env node
/**
 * Regenerate `test/fixtures/run-aggregation-query.json`: real `RunAggregationQueryRequest` bytes,
 * as a real client emits them (issue #93).
 *
 * Same method `capture-fixtures.mjs` uses, over `RunAggregationQuery` instead of `RunQuery`: a stub
 * server that answers just enough to make the SDK's `count()`/`aggregate()` calls serialise and
 * resolve, with no emulator and no network. The decoder reads a wire format this project does not
 * own, and a fixture taken from a real client catches a wrong field number that a self-encoded one
 * would not — the same argument `capture-fixtures.mjs` makes, restated for this RPC.
 *
 * Run by hand, not in CI, and only when the case list below changes:
 *
 *     npm install --no-save @google-cloud/firestore
 *     node packages/record/scripts/capture-aggregation-fixtures.mjs
 *
 * The expected shapes are asserted in `test/decode.test.js` and are written by hand there.
 */
import { createServer } from 'node:http2';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { Firestore, AggregateField } = await import('@google-cloud/firestore').catch(() => {
  console.error('this script needs @google-cloud/firestore:\n  npm install --no-save @google-cloud/firestore');
  process.exit(2);
});

// A `RunAggregationQueryResponse` the SDK accepts as a result: one `aggregate_0` entry (the
// server-side alias the SDK assigns its first aggregation, whatever the client-side alias was) and
// a `read_time`. The client reads only `response.result` truthiness and `readTime` off this path —
// see `aggregate-query.js`'s `_get` — so the value inside `aggregate_0` is never inspected; what
// matters is that the message decodes as one `AggregationResult` a real server could have sent.
// Built with `protobufjs` against the SDK's own bundled descriptor (`build/protos/v1.json`) rather
// than by hand, on the same principle the request fixtures are captured rather than self-encoded.
const protobuf = (await import('protobufjs')).default;
const descriptorPath = fileURLToPath(
  new URL('../../../node_modules/@google-cloud/firestore/build/protos/v1.json', import.meta.url),
);
const root = protobuf.Root.fromJSON(JSON.parse(readFileSync(descriptorPath, 'utf8')));
const ResponseType = root.lookupType('google.firestore.v1.RunAggregationQueryResponse');
const RESPONSE_MESSAGE = ResponseType.encode(
  ResponseType.create({ result: { aggregateFields: { aggregate_0: { integerValue: 0 } } }, readTime: { seconds: 1 } }),
).finish();

/** Each case names an aggregation the way an application would write it. */
const CASES = [
  ['a bare count', (db) => db.collection('orders').count()],
  ['count with a filter', (db) => db.collection('orders').where('status', '==', 'open').count()],
  ['a single sum', (db) => db.collection('orders').aggregate({ total: AggregateField.sum('amount') })],
  ['a single average', (db) => db.collection('orders').aggregate({ mean: AggregateField.average('amount') })],
  [
    'count, sum and average together',
    (db) =>
      db
        .collection('orders')
        .aggregate({
          n: AggregateField.count(),
          total: AggregateField.sum('amount'),
          mean: AggregateField.average('amount'),
        }),
  ],
  ['a collection group aggregation', (db) => db.collectionGroup('items').where('sku', '==', 'x').count()],
  ['a sum on a nested field path', (db) => db.collection('orders').aggregate({ t: AggregateField.sum('cart.total') })],
];

const captured = [];

const server = createServer();
server.on('stream', (stream, headers) => {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', () => {
    if (headers[':path'] === '/google.firestore.v1.Firestore/RunAggregationQuery') {
      // Strip the five-byte gRPC frame header; the fixture is the message, not the framing.
      captured.push(Buffer.concat(chunks).subarray(5).toString('base64'));
    }
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(RESPONSE_MESSAGE.length, 1);
    stream.end(Buffer.concat([header, RESPONSE_MESSAGE]));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${port}`;

const db = new Firestore({ projectId: 'demo-fixtures' });
const cases = [];
for (const [name, build] of CASES) {
  const before = captured.length;
  await build(db).get();
  if (captured.length !== before + 1) throw new Error(`"${name}" produced ${captured.length - before} requests`);
  cases.push({ name, message: captured[captured.length - 1] });
}
await db.terminate();
await new Promise((resolve) => server.close(resolve));

const out = fileURLToPath(new URL('../test/fixtures/run-aggregation-query.json', import.meta.url));
writeFileSync(
  out,
  `${JSON.stringify(
    {
      note:
        'RunAggregationQueryRequest messages as @google-cloud/firestore serialises them, base64. ' +
        'Regenerate with packages/record/scripts/capture-aggregation-fixtures.mjs. ' +
        'The shape each one is expected to decode to is written by hand in test/decode.test.js.',
      cases,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${cases.length} cases to ${out}`);
