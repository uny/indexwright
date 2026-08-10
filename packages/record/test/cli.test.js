import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCorpus } from '../dist/index.js';
import { parseArgs, UsageError } from '../dist/args.js';
import { run } from '../dist/cli.js';

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
