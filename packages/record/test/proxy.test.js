import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttp1Server } from 'node:http';
import { connect, createServer as createHttp2Server } from 'node:http2';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, parseHostPort, startCapture } from '../dist/index.js';

const { cases } = JSON.parse(
  readFileSync(fileURLToPath(new URL('fixtures/run-query.json', import.meta.url)), 'utf8'),
);

function fixtureMessage(name) {
  const found = cases.find((entry) => entry.name === name);
  assert.ok(found, `fixture "${name}" is missing`);
  return Buffer.from(found.message, 'base64');
}

/** Frame a message the way gRPC does: uncompressed flag, big-endian length, payload. */
function frame(message) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

/** A response the client will accept: one RunQueryResponse carrying only a read_time. */
const EMPTY_RESULT = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x04, 0x1a, 0x02, 0x08, 0x01]);

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${server.address().port}`;
}

/** An upstream that answers every call like the emulator would, and records what it was asked. */
function stubUpstream({ trailersOnly = false } = {}) {
  const seen = [];
  const server = createHttp2Server();
  server.on('stream', (stream, headers) => {
    stream.on('data', () => {});
    stream.on('end', () => {
      seen.push(headers[':path']);
      if (trailersOnly) {
        stream.respond(
          { ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '3', 'grpc-message': 'nope' },
          { endStream: true },
        );
        return;
      }
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(EMPTY_RESULT);
    });
  });
  return { server, seen };
}

/** Send one gRPC request through the proxy and report what came back. */
function call(address, path, body) {
  return new Promise((resolve, reject) => {
    const client = connect(`http://${address}`);
    client.on('error', reject);
    const request = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    const chunks = [];
    let headers = null;
    let trailers = null;
    request.on('response', (received) => {
      headers = received;
    });
    request.on('trailers', (received) => {
      trailers = received;
    });
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('close', () => {
      client.close();
      resolve({ headers, trailers, body: Buffer.concat(chunks) });
    });
    request.end(body);
  });
}

test('a RunQuery passes through unchanged and is recorded', async () => {
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const response = await call(
      capture.address,
      '/google.firestore.v1.Firestore/RunQuery',
      frame(fixtureMessage('a collection group query')),
    );

    assert.equal(response.headers[':status'], 200);
    assert.equal(response.trailers['grpc-status'], '0');
    assert.deepEqual(response.body, EMPTY_RESULT, 'the response body reached the client intact');
    assert.deepEqual(upstream.seen, ['/google.firestore.v1.Firestore/RunQuery']);

    assert.deepEqual(
      capture.recorder.shapes.map((shape) => shape.key),
      ['items::COLLECTION_GROUP::AND(sku:EQUAL)::qty:ASCENDING'],
    );
    assert.equal(capture.recorder.skips.size, 0);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('a trailers-only error reaches the client as one, not as a fabricated status', async () => {
  const upstream = stubUpstream({ trailersOnly: true });
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const response = await call(
      capture.address,
      '/google.firestore.v1.Firestore/RunQuery',
      frame(fixtureMessage('no filters and no sort')),
    );
    assert.equal(response.headers['grpc-status'], '3');
    assert.equal(response.headers['grpc-message'], 'nope');
    assert.equal(response.trailers, null, 'a trailers-only response must not gain trailers');
    // SPEC §7: a query enters the corpus when its request is observed, whatever the server says.
    assert.equal(capture.recorder.shapes.length, 1);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('query-bearing RPCs that are not RunQuery are counted, and writes are not', async () => {
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const body = frame(fixtureMessage('no filters and no sort'));
    for (const method of ['Listen', 'PartitionQuery', 'RunAggregationQuery', 'ExecutePipeline', 'Commit']) {
      await call(capture.address, `/google.firestore.v1.Firestore/${method}`, body);
    }
    assert.deepEqual(
      [...capture.recorder.skips.entries()].sort(),
      [
        ['aggregation-query', 1],
        ['listen-query', 1],
        ['partition-query', 1],
        ['unsupported-rpc', 1],
      ],
    );
    assert.equal(capture.recorder.shapes.length, 0);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('a compressed message this package cannot undo is counted, not dropped', async () => {
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const message = fixtureMessage('no filters and no sort');
    const header = Buffer.alloc(5);
    header.writeUInt8(1, 0); // compressed
    header.writeUInt32BE(message.length, 1);
    await new Promise((resolve, reject) => {
      const client = connect(`http://${capture.address}`);
      client.on('error', reject);
      const request = client.request({
        ':method': 'POST',
        ':path': '/google.firestore.v1.Firestore/RunQuery',
        'content-type': 'application/grpc',
        'grpc-encoding': 'snappy',
      });
      request.on('error', reject);
      request.on('close', () => {
        client.close();
        resolve();
      });
      request.resume();
      request.end(Buffer.concat([header, message]));
    });
    assert.equal(capture.recorder.skips.get('unsupported-encoding'), 1);
    assert.equal(capture.recorder.shapes.length, 0);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('HTTP/1.1 is forwarded rather than refused, and is reported as uncaptured', async () => {
  // The emulator's data-clearing endpoint is HTTP/1.1, and a suite that uses it would break if
  // pointing FIRESTORE_EMULATOR_HOST at the proxy meant refusing the protocol.
  const upstream = createHttp1Server((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`saw ${request.method} ${request.url}`);
  });
  const upstreamAddress = await listen(upstream);
  const capture = await startCapture({ upstream: upstreamAddress, onWarning: () => {} });
  try {
    const response = await fetch(`http://${capture.address}/emulator/v1/projects/p/databases/(default)/documents`, {
      method: 'DELETE',
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /^saw DELETE /);
    assert.equal(capture.recorder.http1, 1);
    // Not a corpus skip reason: this is the transport gap of §3, not a query the proxy declined.
    assert.equal(capture.recorder.skips.size, 0);
  } finally {
    await capture.close();
    upstream.close();
  }
});

test('classify routes by the gRPC method, and leaves other services alone', () => {
  assert.deepEqual(classify('/google.firestore.v1.Firestore/RunQuery'), { kind: 'record' });
  assert.deepEqual(classify('/google.firestore.v1.Firestore/Listen'), {
    kind: 'skip',
    reason: 'listen-query',
  });
  assert.deepEqual(classify('/google.firestore.v1.Firestore/Commit'), { kind: 'ignore' });
  assert.deepEqual(classify('/google.firestore.v1.Firestore/SomethingNew'), {
    kind: 'skip',
    reason: 'unsupported-rpc',
  });
  assert.deepEqual(classify('/google.firestore.admin.v1.FirestoreAdmin/CreateIndex'), { kind: 'ignore' });
  assert.deepEqual(classify('/not-a-grpc-path'), { kind: 'ignore' });
});

test('parseHostPort rejects what cannot be an address', () => {
  assert.deepEqual(parseHostPort('127.0.0.1:8080'), { host: '127.0.0.1', port: 8080 });
  assert.deepEqual(parseHostPort('[::1]:8080'), { host: '::1', port: 8080 });
  assert.throws(() => parseHostPort('127.0.0.1'), /host:port/);
  assert.throws(() => parseHostPort('127.0.0.1:0'), /host:port/);
  assert.throws(() => parseHostPort('127.0.0.1:notaport'), /host:port/);
});
