import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttp1Server } from 'node:http';
import { connect, createServer as createHttp2Server } from 'node:http2';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { classify, classifyHttp1, fields, parseHostPort, startCapture } from '../dist/index.js';

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

/** Encode a length-delimited protobuf field. */
function delimited(field, payload) {
  const varint = (value) => {
    const out = [];
    let rest = value;
    do {
      const byte = rest & 0x7f;
      rest >>>= 7;
      out.push(rest > 0 ? byte | 0x80 : byte);
    } while (rest > 0);
    return Buffer.from(out);
  };
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

/** ListenRequest{ add_target: Target{ query: QueryTarget{ structured_query } } } for a fixture. */
function listenAddTarget(name) {
  let structuredQuery = null;
  // RunQueryRequest.structured_query is field 2.
  for (const field of fields(fixtureMessage(name))) if (field.number === 2) structuredQuery = Buffer.from(field.value);
  assert.ok(structuredQuery, `fixture "${name}" carries no structured_query`);
  return delimited(2, delimited(2, delimited(2, structuredQuery)));
}

/** ListenRequest{ remove_target: id }. */
const REMOVE_TARGET = Buffer.from([0x18, 0x01]);

/** Poll until `condition` holds. A fixed sleep would assert the scheduler rather than the recorder. */
async function until(condition, what) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Open a Listen stream through the proxy and hold it open. `write` sends bytes and waits until
 * `expect()` holds on the recorder's side; `finish` ends the request and waits for the response.
 */
function openListen(address) {
  const client = connect(`http://${address}`);
  const request = client.request({
    ':method': 'POST',
    ':path': '/google.firestore.v1.Firestore/Listen',
    'content-type': 'application/grpc',
    te: 'trailers',
  });
  request.on('data', () => {});
  const closed = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('close', () => {
      client.close();
      resolve();
    });
  });
  return {
    write: async (bytes, expect) => {
      await new Promise((resolve, reject) => request.write(bytes, (error) => (error ? reject(error) : resolve())));
      await until(expect, 'the proxy to see the bytes');
    },
    finish: () => {
      request.end();
      return closed;
    },
  };
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
    for (const method of ['PartitionQuery', 'RunAggregationQuery', 'ExecutePipeline', 'Commit']) {
      await call(capture.address, `/google.firestore.v1.Firestore/${method}`, body);
    }
    assert.deepEqual(
      [...capture.recorder.skips.entries()].sort(),
      [
        ['aggregation-query', 1],
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

test('HTTP/1.1 is forwarded rather than refused', async () => {
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
    assert.equal(capture.recorder.observed, 0);
    assert.equal(capture.recorder.skips.size, 0);
  } finally {
    await capture.close();
    upstream.close();
  }
});

const { cases: webCases } = JSON.parse(
  readFileSync(fileURLToPath(new URL('fixtures/web-sdk.json', import.meta.url)), 'utf8'),
);

function webFixture(name) {
  const found = webCases.find((entry) => entry.name === name);
  assert.ok(found, `web fixture "${name}" is missing`);
  return found;
}

/** An HTTP/1.1 upstream that answers everything with 200 and records each request whole. */
function stubHttp1Upstream() {
  const seen = [];
  const server = createHttp1Server((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
  });
  return { server, seen };
}

/** Send one HTTP/1.1 request through the proxy the way the Web SDK does. */
async function post(address, path, body, headers = {}) {
  const response = await fetch(`http://${address}${path}`, { method: 'POST', body, headers });
  return { status: response.status, body: await response.text() };
}

test('a REST documents:runQuery is recorded from its JSON body and forwarded intact', async () => {
  const upstream = stubHttp1Upstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress, onWarning: () => {} });
  try {
    const { rest } = webFixture('a collection group query');
    const response = await post(capture.address, rest.path, rest.body, { 'content-type': rest.contentType });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'ok');
    assert.deepEqual(upstream.seen, [{ method: 'POST', url: rest.path, body: rest.body }]);
    assert.equal(capture.recorder.observed, 1);
    assert.deepEqual(
      capture.recorder.shapes.map((shape) => shape.key),
      ['items::COLLECTION_GROUP::AND(sku:EQUAL)::qty:ASCENDING|__name__:ASCENDING'],
    );
    assert.equal(capture.recorder.skips.size, 0);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('a WebChannel forward channel is recorded message by message, and its other traffic is not', async () => {
  const upstream = stubHttp1Upstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress, onWarning: () => {} });
  try {
    const channel = '/google.firestore.v1.Firestore/Listen/channel';
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    // The first POST of a channel, as captured: `headers=` plus one add_target.
    const first = webFixture('a not-equal filter').forwardChannel;
    await post(capture.address, `${channel}?VER=8&RID=1&CVER=22&X-HTTP-Session-Id=gsessionid&t=1`, first.body, form);
    // A later POST carrying a remove_target and a fresh add_target together, as the SDK batches.
    const second = new URLSearchParams(webFixture('a nested field path').forwardChannel.body).get('req0___data__');
    const batched = new URLSearchParams({
      count: '2',
      ofs: '3',
      req0___data__: JSON.stringify({ database: 'd', removeTarget: 1002 }),
      req1___data__: second,
    });
    await post(capture.address, `${channel}?VER=8&SID=abc&RID=2&AID=7&t=1`, batched.toString(), form);
    // The backward channel is a GET, the Write channel carries no query, and a preflight asks first.
    await fetch(`http://${capture.address}${channel}?VER=8&SID=abc&RID=rpc&AID=8&TYPE=xmlhttp&t=1`);
    await post(capture.address, '/google.firestore.v1.Firestore/Write/channel?VER=8&RID=3&t=1', 'count=1&ofs=0&req0___data__=%7B%22database%22%3A%22d%22%7D', form);
    await fetch(`http://${capture.address}/v1/projects/p/databases/(default)/documents:runQuery`, { method: 'OPTIONS' });

    assert.equal(upstream.seen.length, 5, 'every request reached the upstream');
    assert.equal(capture.recorder.observed, 2);
    assert.deepEqual(
      capture.recorder.shapes.map((shape) => shape.key),
      [
        'orders::COLLECTION::AND(state:NOT_EQUAL)::state:ASCENDING|__name__:ASCENDING',
        'orders::COLLECTION::AND(profile.city:EQUAL)::__name__:ASCENDING',
      ],
    );
    assert.equal(capture.recorder.skips.size, 0);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('REST calls the corpus cannot model are counted under the reasons gRPC calls are', async () => {
  const upstream = stubHttp1Upstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress, onWarning: () => {} });
  try {
    const documents = '/v1/projects/p/databases/(default)/documents';
    const text = { 'content-type': 'text/plain' };
    await post(capture.address, `${documents}:runAggregationQuery`, '{"structuredAggregationQuery":{}}', text);
    await post(capture.address, `${documents}:partitionQuery`, '{"structuredQuery":{}}', text);
    await post(capture.address, `${documents}:executePipeline`, '{}', text);
    // Not a query: a write, a lookup, and a document created by path.
    await post(capture.address, `${documents}:commit`, '{"writes":[]}', text);
    await post(capture.address, `${documents}:batchGet`, '{"documents":[]}', text);
    await post(capture.address, `${documents}/orders`, '{"fields":{}}', text);
    // A body that is not JSON on a query-bearing call is a defect, and is counted as one.
    await post(capture.address, `${documents}:runQuery`, '{"structuredQuery":', text);
    // One the proxy cannot read because it is compressed, which the Web SDK never sends.
    await post(capture.address, `${documents}:runQuery`, gzipSync('{}'), { ...text, 'content-encoding': 'gzip' });

    assert.equal(upstream.seen.length, 8);
    assert.equal(capture.recorder.shapes.length, 0);
    assert.deepEqual(
      [...capture.recorder.skips.entries()].sort(),
      [
        ['aggregation-query', 1],
        ['partition-query', 1],
        ['undecodable-message', 1],
        ['unsupported-encoding', 1],
        ['unsupported-rpc', 1],
      ],
    );
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('classifyHttp1 reads the REST custom method and the WebChannel path, and leaves the rest alone', () => {
  const documents = '/v1/projects/p/databases/(default)/documents';
  assert.deepEqual(classifyHttp1('POST', `${documents}:runQuery`), { kind: 'record', method: 'RestRunQuery' });
  // A subcollection parent is spelled into the path before the colon.
  assert.deepEqual(classifyHttp1('POST', `${documents}/orders/o1:runQuery`), { kind: 'record', method: 'RestRunQuery' });
  assert.deepEqual(classifyHttp1('POST', `${documents}:runQuery?alt=json`), { kind: 'record', method: 'RestRunQuery' });
  assert.deepEqual(classifyHttp1('POST', `${documents}:runAggregationQuery`), { kind: 'skip', reason: 'aggregation-query' });
  assert.deepEqual(classifyHttp1('POST', `${documents}:partitionQuery`), { kind: 'skip', reason: 'partition-query' });
  assert.deepEqual(classifyHttp1('POST', `${documents}:somethingNew`), { kind: 'skip', reason: 'unsupported-rpc' });
  // REST spells it, the Web SDK never sends it, and it is a query-bearing call this package does not read.
  assert.deepEqual(classifyHttp1('POST', `${documents}:listen`), { kind: 'skip', reason: 'unsupported-rpc' });
  assert.deepEqual(classifyHttp1('POST', `${documents}:commit`), { kind: 'ignore' });
  assert.deepEqual(classifyHttp1('POST', `${documents}/orders`), { kind: 'ignore' });
  assert.deepEqual(classifyHttp1('GET', `${documents}/orders/o1`), { kind: 'ignore' });
  assert.deepEqual(classifyHttp1('PATCH', `${documents}/orders/o1`), { kind: 'ignore' });
  assert.deepEqual(classifyHttp1('DELETE', '/emulator/v1/projects/p/databases/(default)/documents'), { kind: 'ignore' });

  const channel = (method) => `/google.firestore.v1.Firestore/${method}/channel?VER=8&RID=1&t=1`;
  assert.deepEqual(classifyHttp1('POST', channel('Listen')), { kind: 'record', method: 'ForwardChannel' });
  assert.deepEqual(classifyHttp1('GET', channel('Listen')), { kind: 'ignore' });
  assert.deepEqual(classifyHttp1('OPTIONS', channel('Listen')), { kind: 'ignore' });
  assert.deepEqual(classifyHttp1('POST', channel('Write')), { kind: 'ignore' });
  assert.deepEqual(classifyHttp1('POST', channel('RunQuery')), { kind: 'skip', reason: 'unsupported-rpc' });
  assert.deepEqual(classifyHttp1('POST', channel('SomethingNew')), { kind: 'skip', reason: 'unsupported-rpc' });
  assert.deepEqual(classifyHttp1('POST', '/other.Service/Listen/channel'), { kind: 'ignore' });
  assert.deepEqual(classifyHttp1(undefined, undefined), { kind: 'ignore' });
});

test('classify routes by the gRPC method, and leaves other services alone', () => {
  assert.deepEqual(classify('/google.firestore.v1.Firestore/RunQuery'), { kind: 'record', method: 'RunQuery' });
  assert.deepEqual(classify('/google.firestore.v1.Firestore/Listen'), { kind: 'record', method: 'Listen' });
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
  const sessions = [];
  const closed = new Promise((resolve) => {
    upstream.on('session', (session) => {
      sessions.push(session);
      session.on('close', () => resolve('session closed'));
    });
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
    // Unref'd because a won race leaves the timer pending: ref'd, every passing run would hold
    // the loop for the remainder of the ten seconds.
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
    // Destroyed before the close, because the path that gets here with one still open is the
    // regression path, and on 22 — the engines floor, and a CI leg — `close` withholds its
    // callback until every session has ended. Without this the deadline above bounds the
    // assertion and nothing else: the run reported `TAP version 13` and then hung, where 24
    // failed at 10s with the message. `node --test` has no default per-test timeout and CI sets
    // no `timeout-minutes`, so that is the job's whole six hours to say what one line says here.
    for (const session of sessions) session.destroy();
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
  //
  // 'TCPSocketWrap' is what `getActiveResourcesInfo` calls a socket on Node 22 through 26; it never
  // said 'TCPWRAP', and counting that kind compared zero with zero, so this test passed with the
  // socket's `destroy` removed while the process hung the full 75 seconds.
  const sockets = () => process.getActiveResourcesInfo().filter((kind) => kind === 'TCPSocketWrap').length;
  const settle = async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  // Settled before the baseline too: the test before this one has just closed sockets of its own,
  // and their handles are still being released.
  await settle();
  const before = sockets();
  const capture = await startCapture({
    upstream: '192.0.2.1:8080',
    allowRemoteUpstream: true,
    onWarning: () => {},
  });
  await capture.close();
  // A destroyed socket's handle is released from the close-callbacks phase, two turns after `close`
  // resolves; twenty is the same bound as the test below, for the same reason.
  await settle();
  assert.equal(sockets(), before, 'close left a socket open');
});

test('closing a pending upstream connection is not reported as an upstream failure', async () => {
  // The companion to the pending-connect test: the socket's `destroy` frees the handle, and the
  // session's `destroy` is what keeps `close` from warning "upstream connection: Socket is closed"
  // about the socket it pulled itself — see the comment on that line in `close`. Issue #35 measured
  // the line's removal as invisible to the suite; this is what sees it.
  const warnings = [];
  const capture = await startCapture({
    upstream: '192.0.2.1:8080',
    allowRemoteUpstream: true,
    onWarning: (message) => warnings.push(message),
  });
  await capture.close();
  // The 'error' that would arrive is delivered from the socket's 'close', which is emitted from the
  // loop's close-callbacks phase after `destroy` and lands here on the second full turn. A negative
  // assertion needs a bound, and twenty turns is that bound: ten times what the event needs, and no
  // clock involved.
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  // Only the self-inflicted warning is judged. On a host with no route to TEST-NET-1 the dial fails
  // outright instead of pending, and the session reports that before `close` runs — a real upstream
  // failure, not this test's subject; on such a host this test passes without pinning anything.
  assert.deepEqual(
    warnings.filter((message) => message.includes('Socket is closed')),
    [],
  );
});

test('a Listen target is recorded while the stream is still open', async () => {
  // Issue #6: the stream lives as long as the listener does, so a recorder that waited for it to
  // end would hold a suite's every snapshot query until teardown — or forever, for a listener the
  // suite never detaches. The shape has to be there the moment its frame is.
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const stream = openListen(capture.address);
    await stream.write(frame(listenAddTarget('a collection group query')), () => capture.recorder.observed === 1);
    assert.equal(capture.recorder.shapes.length, 1);
    assert.equal(capture.recorder.shapes[0].key, 'items::COLLECTION_GROUP::AND(sku:EQUAL)::qty:ASCENDING');
    assert.equal(capture.recorder.observed, 1);

    // The same target re-sent, as a client does after a reconnect: one key, still.
    await stream.write(frame(listenAddTarget('a collection group query')), () => capture.recorder.observed === 2);
    assert.equal(capture.recorder.shapes.length, 1);

    // Control traffic is neither a shape nor a skip. Nothing to wait for, so the next write's
    // condition is what proves it: if the remove had counted, `observed` would reach 3 too early.
    await stream.write(frame(REMOVE_TARGET), () => true);

    // A second query on the same stream, and the two frames arriving in one write.
    await stream.write(
      Buffer.concat([frame(listenAddTarget('no filters and no sort')), frame(REMOVE_TARGET)]),
      () => capture.recorder.shapes.length === 2,
    );
    assert.equal(capture.recorder.observed, 3);
    assert.equal(capture.recorder.skips.size, 0);

    await stream.finish();
    assert.equal(capture.recorder.skips.size, 0);
    assert.deepEqual(upstream.seen, ['/google.firestore.v1.Firestore/Listen']);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('a Listen frame split across writes is read once it completes', async () => {
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const stream = openListen(capture.address);
    const framed = frame(listenAddTarget('a collection group query'));
    await stream.write(framed.subarray(0, 3), () => true);
    await stream.write(framed.subarray(3, 12), () => true);
    assert.equal(capture.recorder.shapes.length, 0);
    await stream.write(framed.subarray(12), () => capture.recorder.shapes.length === 1);
    await stream.finish();
    assert.equal(capture.recorder.skips.size, 0);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('a Listen stream that ends mid-frame is counted, and one that ends empty is not', async () => {
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const empty = openListen(capture.address);
    await empty.finish();
    // Not a RunQuery with no message: a Listen that carried nothing is a stream that opened and
    // closed, and there is no query it could have been.
    assert.equal(capture.recorder.observed, 0);
    assert.equal(capture.recorder.skips.size, 0);

    const truncated = openListen(capture.address);
    await truncated.write(frame(listenAddTarget('a collection group query')).subarray(0, 9), () => true);
    await truncated.finish();
    assert.equal(capture.recorder.skips.get('undecodable-message'), 1);
    assert.equal(capture.recorder.shapes.length, 0);

    // A frame past the cap is one message, counted once when its header is read — not again when
    // the stream ends before the declared length has arrived. Only the header is sent: the cap is
    // on what is declared, not on what the client goes on to deliver.
    const oversized = openListen(capture.address);
    const header = Buffer.alloc(5);
    header.writeUInt32BE(64 * 1024 * 1024, 1);
    await oversized.write(Buffer.concat([header, Buffer.alloc(16)]), () => capture.recorder.observed === 2);
    await oversized.finish();
    assert.equal(capture.recorder.skips.get('undecodable-message'), 2);
    assert.equal(capture.recorder.observed, 2);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});

test('a gzipped Listen frame is decompressed and recorded', async () => {
  const upstream = stubUpstream();
  const upstreamAddress = await listen(upstream.server);
  const capture = await startCapture({ upstream: upstreamAddress });
  try {
    const compressed = gzipSync(listenAddTarget('a collection group query'));
    const header = Buffer.alloc(5);
    header[0] = 1;
    header.writeUInt32BE(compressed.length, 1);
    const client = connect(`http://${capture.address}`);
    const request = client.request({
      ':method': 'POST',
      ':path': '/google.firestore.v1.Firestore/Listen',
      'content-type': 'application/grpc',
      'grpc-encoding': 'gzip',
      te: 'trailers',
    });
    request.on('data', () => {});
    await new Promise((resolve, reject) => {
      request.on('error', reject);
      request.on('close', resolve);
      request.end(Buffer.concat([header, compressed]));
    });
    client.close();
    assert.equal(capture.recorder.shapes.length, 1);
    assert.equal(capture.recorder.skips.size, 0);
  } finally {
    await capture.close();
    upstream.server.close();
  }
});
