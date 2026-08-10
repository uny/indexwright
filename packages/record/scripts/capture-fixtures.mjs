#!/usr/bin/env node
/**
 * Regenerate `test/fixtures/run-query.json`: real `RunQueryRequest` bytes, as a real client emits
 * them.
 *
 * The decoder reads a wire format this project does not own, and the failure mode that matters is
 * a field number that is quietly wrong — it yields a tree with the right structure and no names in
 * it. Fixtures taken from a real client are what catch that; a message this project also encoded
 * would only prove the decoder agrees with itself.
 *
 * There is no emulator here and no Java. The client talks to a stub that answers every `RunQuery`
 * with an empty result, which is enough to make it serialise the request.
 *
 * Run by hand, not in CI, and only when the case list below changes:
 *
 *     npm install --no-save @google-cloud/firestore
 *     node packages/record/scripts/capture-fixtures.mjs
 *
 * The expected shapes are asserted in `test/decode.test.js` and are written by hand there. Nothing
 * in this script decides what a case *should* decode to; it only records what the client sent.
 */
import { createServer } from 'node:http2';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { Firestore, Filter, FieldPath } = await import('@google-cloud/firestore').catch(() => {
  console.error('this script needs @google-cloud/firestore:\n  npm install --no-save @google-cloud/firestore');
  process.exit(2);
});

/** Each case names a query the way an application would write it. */
const CASES = [
  ['equality and inequality with two sorts', (db) =>
    db.collection('orders').where('status', '==', 'open').where('amount', '>', 1)
      .orderBy('amount', 'desc').orderBy('createdAt', 'asc').limit(10)],
  ['the same query with its filters written in the other order', (db) =>
    db.collection('orders').where('amount', '>', 1).where('status', '==', 'open')
      .orderBy('amount', 'desc').orderBy('createdAt', 'asc')],
  ['a collection group query', (db) =>
    db.collectionGroup('items').where('sku', '==', 'x').orderBy('qty')],
  ['no filters and no sort', (db) => db.collection('orders')],
  ['a disjunction nested under a conjunction', (db) =>
    db.collection('orders')
      .where(Filter.or(Filter.where('tier', '==', 'a'), Filter.where('tier', '==', 'b')))
      .where('tags', 'array-contains', 'sale')],
  ['every field operator', (db) =>
    db.collection('orders')
      .where('a', '<', 1).where('b', '<=', 1).where('c', '>', 1).where('d', '>=', 1)
      .where('e', '==', 1).where('f', 'array-contains', 1)
      .where('g', 'in', [1]).where('h', 'array-contains-any', [1])],
  ['a not-equal filter', (db) => db.collection('orders').where('state', '!=', 'void')],
  ['a not-in filter', (db) => db.collection('orders').where('state', 'not-in', ['void'])],
  ['null and NaN, which reach the wire as unary filters', (db) =>
    db.collection('orders').where('deletedAt', '==', null).where('score', '==', Number.NaN)],
  ['not-null and not-NaN', (db) =>
    db.collection('orders').where('deletedAt', '!=', null).where('score', '!=', Number.NaN)],
  ['a sort on the document key', (db) =>
    db.collection('orders').orderBy(FieldPath.documentId(), 'desc')],
  ['a field path that holds the key delimiters', (db) =>
    db.collection('orders').where(new FieldPath('weird:path|with(parens)'), '==', 1)],
  ['a nested field path', (db) => db.collection('orders').where('profile.city', '==', 'kyoto')],
];

const captured = [];

const server = createServer();
server.on('stream', (stream, headers) => {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', () => {
    if (headers[':path'] === '/google.firestore.v1.Firestore/RunQuery') {
      // Strip the five-byte gRPC frame header; the fixture is the message, not the framing.
      captured.push(Buffer.concat(chunks).subarray(5).toString('base64'));
    }
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    // One RunQueryResponse carrying only read_time (field 3, a Timestamp of one second): an empty
    // result set the client will accept. Without it the SDK reports "No QuerySnapshot result".
    stream.end(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x04, 0x1a, 0x02, 0x08, 0x01]));
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

const out = fileURLToPath(new URL('../test/fixtures/run-query.json', import.meta.url));
writeFileSync(
  out,
  `${JSON.stringify(
    {
      note:
        'RunQueryRequest messages as @google-cloud/firestore serialises them, base64. ' +
        'Regenerate with packages/record/scripts/capture-fixtures.mjs. ' +
        'The shape each one is expected to decode to is written by hand in test/decode.test.js.',
      cases,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${cases.length} cases to ${out}`);
