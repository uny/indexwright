import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCorpus } from '../dist/index.js';
import { parseArgs, UsageError } from '../dist/args.js';
import { run, shouldForward } from '../dist/cli.js';

function collect() {
  const out = [];
  const err = [];
  return { out: (text) => out.push(text), err: (text) => err.push(text), stdout: () => out.join(''), stderr: () => err.join('') };
}

test('the command to run goes after --, and options before it', () => {
  const command = parseArgs(['--out', 'corpus.json', '--emulator', '127.0.0.1:9', '--', 'npm', 'test']);
  assert.equal(command.kind, 'record');
  assert.equal(command.out, 'corpus.json');
  assert.equal(command.emulator, '127.0.0.1:9');
  assert.deepEqual(command.argv, ['npm', 'test']);
});

test('flags belonging to the command being run are not intercepted', () => {
  const command = parseArgs(['--', 'npm', 'test', '--help', '--version']);
  assert.equal(command.kind, 'record');
  assert.deepEqual(command.argv, ['npm', 'test', '--help', '--version']);
});

test('the emulator defaults to the environment the suite would have used', () => {
  const command = parseArgs(['--', 'true'], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:9999' });
  assert.equal(command.emulator, '127.0.0.1:9999');
  assert.equal(parseArgs(['--', 'true'], {}).emulator, '127.0.0.1:8080');
});

test('a run with no command to run is a usage error', () => {
  assert.throws(() => parseArgs(['--out', 'x.json']), UsageError);
  assert.throws(() => parseArgs(['npm', 'test']), (error) => /after "--"/.test(error.message));
  assert.throws(() => parseArgs(['--nope', '--', 'true']), (error) => /unknown option/.test(error.message));
});

test('--help and --version report without running anything', async () => {
  const help = collect();
  assert.equal(await run(['--help'], help), 0);
  assert.match(help.stdout(), /indexwright-record \[options\]/);

  const version = collect();
  assert.equal(await run(['--version'], version), 0);
  assert.match(version.stdout(), /^\d+\.\d+\.\d+/);
});

test('a usage error exits 2 and prints the usage', async () => {
  const streams = collect();
  assert.equal(await run(['--out'], streams), 2);
  assert.match(streams.stderr(), /--out needs a value/);
});

test('the corpus is written and the exit code is the suite’s', async () => {
  const upstream = createServer();
  upstream.on('stream', (stream) => {
    stream.on('data', () => {});
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-record-'));

  try {
    const out = join(directory, 'firestore.queries.json');
    const streams = collect();
    // The child does nothing but fail, which is the case that matters: a corpus is evidence of
    // what a run exercised, and a failing run still exercised it.
    const status = await run(
      ['--emulator', `127.0.0.1:${upstream.address().port}`, '--out', out, '--', process.execPath, '-e', 'process.exit(3)'],
      streams,
      {},
    );

    assert.equal(status, 3, 'the suite’s exit code is the tool’s');
    const corpus = parseCorpus(readFileSync(out, 'utf8'));
    assert.deepEqual(corpus.queries, []);
    assert.deepEqual(corpus.skipped, []);
    assert.match(streams.stderr(), /0 query request\(s\) observed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    upstream.close();
  }
});

test('a command that cannot be started is reported, not thrown', async () => {
  const upstream = createServer();
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-record-'));

  try {
    const out = join(directory, 'corpus.json');
    const streams = collect();
    const status = await run(
      ['--emulator', `127.0.0.1:${upstream.address().port}`, '--out', out, '--', 'indexwright-no-such-command'],
      streams,
      {},
    );
    assert.equal(status, 2);
    assert.match(streams.stderr(), /could not run indexwright-no-such-command/);
    // Nothing ran, so there is nothing for a corpus to be evidence of.
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    upstream.close();
  }
});

test('an inherited non-loopback emulator exits 2 and names the variable, without starting a proxy', async () => {
  // The UsageError rewrap in parseArgs is what makes this exit 2 with the usage rather than throwing
  // an EndpointError out of run(); nothing else asserts that the two are wired that way.
  const streams = collect();
  assert.equal(await run(['--', 'true'], streams, { FIRESTORE_EMULATOR_HOST: 'firestore:8080' }), 2);
  assert.match(streams.stderr(), /FIRESTORE_EMULATOR_HOST is set to "firestore:8080"/);
  assert.match(streams.stderr(), /--allow-remote-emulator/);
});

test('--allow-remote-emulator carries through parseArgs into the proxy, so the escape hatch works', async () => {
  // The whole documented remote path: without the pass-through in cli.ts the flag parses fine and
  // then startCapture refuses anyway, so the run dies at exit 2 with a green test suite.
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-record-'));
  try {
    const out = join(directory, 'corpus.json');
    const streams = collect();
    // TEST-NET-1 (RFC 5737): reserved for documentation and routed nowhere. The connection is really
    // opened — `http2.connect` is not lazy about the socket — so this must not be an address that
    // could belong to someone.
    const status = await run(
      ['--allow-remote-emulator', '--emulator', '192.0.2.1:8080', '--out', out, '--', process.execPath, '-e', ''],
      streams,
      {},
    );
    assert.equal(status, 0, streams.stderr());
    assert.doesNotMatch(streams.stderr(), /could not start the capture proxy/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A suite that issues one query through the proxy, says so, and then does not end.
 *
 * It has to be a real RunQuery rather than a sleep: the property under test is that what the proxy
 * observed before the interrupt survives it, and an empty corpus is written by the uninterrupted
 * path too, so a sleeping child could not tell the two apart.
 */
const QUERYING_CHILD = `
const { connect } = require('node:http2');
const message = Buffer.from(process.env.INDEXWRIGHT_TEST_QUERY, 'base64');
const header = Buffer.alloc(5);
header.writeUInt32BE(message.length, 1);
const client = connect('http://' + process.env.FIRESTORE_EMULATOR_HOST);
const request = client.request({
  ':method': 'POST',
  ':path': '/google.firestore.v1.Firestore/RunQuery',
  'content-type': 'application/grpc',
  te: 'trailers',
});
request.on('data', () => {});
request.on('close', () => {
  client.close();
  // Read by the test as the signal that a query has been captured and it is safe to interrupt.
  console.log('recorded');
  setTimeout(() => {}, 30_000);
});
request.end(Buffer.concat([header, message]));
`;

test('a terminal has already given the suite the interrupt, so it is not sent twice', () => {
  // The suite shares this process group, so a tty's Ctrl-C reached it directly. A second copy is not
  // a duplicate that costs nothing: runners read a repeated interrupt as "quit now" and skip the
  // cleanup that handling the signal at all is meant to let them finish.
  assert.equal(shouldForward('SIGINT', true), false);
  assert.equal(shouldForward('SIGINT', false), true);
  // Never generated by a terminal, so it was aimed at this process and nothing else delivered it —
  // including on a tty, where SIGINT is not forwarded.
  assert.equal(shouldForward('SIGTERM', true), true);
  assert.equal(shouldForward('SIGTERM', false), true);
});

test('an interrupted run still writes the corpus, and exits 130', async () => {
  // Spawned rather than driven through `run()` in-process: the fix installs handlers on `process`,
  // and the thing being asserted is what a real Ctrl-C does to a real recorder — including that it
  // does not take the recorder down before the corpus is written.
  const upstream = createServer();
  upstream.on('stream', (stream) => {
    stream.on('data', () => {});
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-record-'));

  const { cases } = JSON.parse(
    readFileSync(fileURLToPath(new URL('fixtures/run-query.json', import.meta.url)), 'utf8'),
  );
  const query = cases.find((entry) => entry.name === 'a collection group query');
  assert.ok(query, 'fixture "a collection group query" is missing');

  const out = join(directory, 'corpus.json');
  const env = { ...process.env, INDEXWRIGHT_TEST_QUERY: query.message };
  // The recorder reads this one from the environment when `--emulator` is absent; it is not absent
  // here, but an inherited value has no business reaching a test about something else.
  delete env.FIRESTORE_EMULATOR_HOST;

  const recorder = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
      '--emulator',
      `127.0.0.1:${upstream.address().port}`,
      '--out',
      out,
      '--',
      process.execPath,
      '-e',
      QUERYING_CHILD,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env },
  );

  let stdout = '';
  let stderr = '';
  recorder.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  recorder.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => recorder.on('close', (code, signal) => resolve({ code, signal })));

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the suite never issued its query\n${stdout}${stderr}`)),
        15_000,
      );
      const settle = (fail) => {
        clearTimeout(timer);
        if (fail) reject(fail);
        else resolve();
      };
      recorder.stdout.on('data', () => {
        if (stdout.includes('recorded')) settle();
      });
      recorder.on('close', () => settle(new Error(`the recorder exited early\n${stdout}${stderr}`)));
    });

    // Sent to the recorder alone, not to a process group, so the suite only stops if the recorder
    // passes the signal on — which is the half of the fix that lets the suite run its own cleanup.
    recorder.kill('SIGINT');
    const { code, signal } = await exited;

    assert.equal(
      signal,
      null,
      `the recorder was killed by ${signal} instead of handling it, so nothing after it ran\n${stderr}`,
    );
    assert.equal(code, 130, `128 + SIGINT, whatever the suite made of the signal\n${stderr}`);

    const corpus = parseCorpus(readFileSync(out, 'utf8'));
    assert.equal(corpus.queries.length, 1, 'the query observed before the interrupt survived it');
    assert.match(stderr, /interrupted by SIGINT/);
    assert.match(stderr, /1 query request\(s\) observed/);
  } finally {
    recorder.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
    upstream.close();
  }
});

test('the child is told where the proxy is, not where the emulator is', async () => {
  const upstream = createServer();
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const emulator = `127.0.0.1:${upstream.address().port}`;
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-record-'));

  try {
    const streams = collect();
    const status = await run(
      [
        '--emulator',
        emulator,
        '--out',
        join(directory, 'corpus.json'),
        '--',
        process.execPath,
        '-e',
        `if (process.env.FIRESTORE_EMULATOR_HOST === ${JSON.stringify(emulator)}) process.exit(1);` +
          'if (!/^127\\.0\\.0\\.1:\\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) process.exit(2);',
      ],
      streams,
      {},
    );
    assert.equal(status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    upstream.close();
  }
});
