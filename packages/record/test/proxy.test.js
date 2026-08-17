import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttp1Server } from 'node:http';
import { connect, createServer as createHttp2Server } from 'node:http2';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
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

test('a gzipped message is decompressed and recorded, not counted as a skip', async () => {
  // The only path that captures anything from a client with gRPC compression enabled. If the
  // encoding key or the payload slice were wrong, every compressed query would land in `skipped`
  // and the corpus would report `queries: []` for a suite that issued dozens.
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const compressed = gzipSync(fixtureMessage('a collection group query'));
    const header = Buffer.alloc(5);
    header.writeUInt8(1, 0); // compressed
    header.writeUInt32BE(compressed.length, 1);
    await new Promise((resolve, reject) => {
      const client = connect(`http://${capture.address}`);
      client.on('error', reject);
      const request = client.request({
        ':method': 'POST',
        ':path': '/google.firestore.v1.Firestore/RunQuery',
        'content-type': 'application/grpc',
        'grpc-encoding': 'gzip',
      });
      request.on('error', reject);
      request.on('close', () => {
        client.close();
        resolve();
      });
      request.resume();
      request.end(Buffer.concat([header, compressed]));
    });
    assert.equal(capture.recorder.skips.size, 0);
    assert.deepEqual(
      capture.recorder.shapes.map((shape) => shape.key),
      ['items::COLLECTION_GROUP::AND(sku:EQUAL)::qty:ASCENDING'],
    );
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
  // Without brackets the last colon is not the port separator, and "::1" would otherwise parse as
  // the host ":" on port 1 — a usage error accepted as an address nobody meant.
  assert.throws(() => parseHostPort('::1'), /brackets/);
  assert.throws(() => parseHostPort('fe80::1:8080'), /brackets/);
});

test('a RunQuery that carries no message at all is counted rather than passed over', async () => {
  // Zero frames is not zero queries: the proxy saw a query-bearing call. Recording nothing for it
  // without saying so is how a dropped query comes to look like one that was never issued.
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    await call(capture.address, '/google.firestore.v1.Firestore/RunQuery', Buffer.alloc(0));
    assert.equal(capture.recorder.observed, 1);
    assert.equal(capture.recorder.skips.get('undecodable-message'), 1);
    assert.equal(capture.recorder.shapes.length, 0);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('an IPv6 emulator address is an address the proxy can reach', async (t) => {
  // parseHostPort strips the brackets, and "http://::1:8080" is not a URL — without putting them
  // back, a documented `host:port` fails to connect at all instead of proxying.
  const upstream = stubUpstream();
  await new Promise((resolve, reject) => {
    upstream.server.once('error', reject);
    upstream.server.listen(0, '::1', resolve);
  }).catch(() => null);
  if (upstream.server.address() === null) {
    upstream.server.close();
    // Skipped, not returned: a host without IPv6 loopback has nothing to assert here, and a
    // silent early return would report this as coverage the run never had.
    t.skip('no IPv6 loopback on this host');
    return;
  }
  const capture = await startCapture({ upstream: `[::1]:${upstream.server.address().port}` });
  try {
    const response = await call(
      capture.address,
      '/google.firestore.v1.Firestore/RunQuery',
      frame(fixtureMessage('no filters and no sort')),
    );
    assert.equal(response.headers[':status'], 200);
    assert.equal(capture.recorder.shapes.length, 1);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('an upstream that has gone away fails the stream rather than the recorder', async () => {
  // The upstream session is shared by every stream. If the emulator restarts mid-run, `request`
  // throws synchronously inside the `stream` handler; unguarded, that ends the recorder process
  // and takes the suite it is running with it.
  const upstream = stubUpstream();
  const sessions = [];
  upstream.server.on('session', (session) => sessions.push(session));
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress, onWarning: () => {} });
  try {
    // Wait for the proxy's session to exist, then take the emulator away under it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    upstream.server.close();
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const code = await new Promise((resolve, reject) => {
      const client = connect(`http://${capture.address}`);
      client.on('error', reject);
      const request = client.request({
        ':method': 'POST',
        ':path': '/google.firestore.v1.Firestore/RunQuery',
        'content-type': 'application/grpc',
      });
      request.on('error', (error) => {
        client.close();
        resolve(error.code);
      });
      request.on('close', () => {
        client.close();
        resolve(null);
      });
      request.resume();
      request.end(frame(fixtureMessage('no filters and no sort')));
    });

    // The client is told the call failed. What matters is that this line is reached at all: the
    // process is still alive to assert it.
    assert.ok(code === null || code.startsWith('ERR_HTTP2'), `unexpected code ${code}`);
  } finally {
    await capture.close();
  }
});

test('a failed listen takes the upstream session down with it', async () => {
  // The upstream connection is opened before the listener is bound, so a bind that fails has to
  // close it on the way out. Asserted from the upstream's side, which is the only place the
  // difference is observable: the session arrives either way, and without the cleanup it stays.
  const upstream = createHttp2Server();
  const closed = new Promise((resolve) => {
    upstream.on('session', (session) => session.on('close', () => resolve('session closed')));
  });
  const upstreamAddress = await listen(upstream);

  // Something already holding the port the proxy will ask for.
  const squatter = createHttp2Server();
  const busy = Number((await listen(squatter)).split(':')[1]);

  try {
    await assert.rejects(
      () => startCapture({ upstream: upstreamAddress, port: busy, onWarning: () => {} }),
      (error) => error.code === 'EADDRINUSE',
    );
    // Bounded, but only to keep a regression from hanging the suite: the assertion is that the
    // session closes at all, not that it closes promptly. The suite's files run in parallel
    // processes, so a deadline tight enough to time the cleanup times the machine's load instead.
    assert.equal(
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error('the upstream session was still open 10s after the failed listen')),
            10_000,
          ).unref();
        }),
      ]),
      'session closed',
    );
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('a wildcard upstream reaches the emulator on this host, which is why it is permitted', async () => {
  // The justification for allowing 0.0.0.0 as an upstream, asserted rather than argued: the emulator
  // listens on 127.0.0.1, the proxy is pointed at 0.0.0.0, and the call arrives. Nothing leaves the
  // machine, so refusing this only ever refused a local emulator.
  const upstream = stubUpstream();
  await new Promise((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
  const port = upstream.server.address().port;

  const capture = await startCapture({ upstream: `0.0.0.0:${port}` });
  try {
    const path = '/google.firestore.v1.Firestore/RunQuery';
    const { headers } = await call(capture.address, path, frame(fixtureMessage('no filters and no sort')));
    assert.equal(headers[':status'], 200);
    assert.deepEqual(upstream.seen, [path], 'the request reached the 127.0.0.1 emulator');
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('closing destroys a pending upstream connection, so a run does not hang after it', async () => {
  // The upstream being unreachable is exactly the state a run ends in when it was pointed at the
  // wrong emulator: the suite has finished and the corpus is written, and the process then has
  // nothing left to do. A session's `destroy` does not tear down a TCP connection that has not been
  // established yet, and `session.socket` refuses `destroy` with ERR_HTTP2_NO_SOCKET_MANIPULATION,
  // so the socket used to survive close and hold the event loop open until the OS gave up on the
  // connect — 75 seconds on macOS, after a capture that had in fact succeeded.
  //
  // 192.0.2.1 is TEST-NET-1 (RFC 5737): reserved for documentation and routed nowhere, so the
  // connect stays pending rather than being refused. It must not be an address that could belong to
  // someone, because it is really dialled — `http2.connect` opens the socket immediately.
  const before = process.getActiveResourcesInfo().filter((kind) => kind === 'TCPWRAP').length;
  const capture = await startCapture({
    upstream: '192.0.2.1:8080',
    allowRemoteUpstream: true,
    onWarning: () => {},
  });
  await capture.close();
  const after = process.getActiveResourcesInfo().filter((kind) => kind === 'TCPWRAP').length;
  assert.equal(after, before, 'close left a socket open');
});
