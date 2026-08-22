#!/usr/bin/env node
/**
 * Exercise what a consumer of `@indexwright/record` gets.
 *
 * The end-to-end check runs the installed bin against a stub upstream and reads the corpus it
 * wrote: the tarball is only good if the thing it installs can capture a query, and a `--version`
 * that works proves nothing about that.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDeclaredDependencies,
  checkShippedFiles,
  createChecker,
  finish,
  run,
  withInstalledTarball,
} from './lib/tarball.mjs';

const packageRoot = fileURLToPath(new URL('../packages/record', import.meta.url));
/** Its in-repo runtime dependency, installed from this tree so the pair is checked together. */
const linterRoot = fileURLToPath(new URL('../packages/indexwright', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const checker = createChecker();
const { check } = checker;

/**
 * A server that answers RunQuery the way the emulator would, so the bin has something to proxy.
 *
 * It reports its port through a file rather than stdout: the checks around it are synchronous, and
 * a parent blocked between `execFileSync` calls cannot read a pipe.
 */
const STUB_UPSTREAM = `
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http2';
const server = createServer();
server.on('stream', (stream) => {
  stream.on('data', () => {});
  stream.on('end', () => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end();
  });
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.argv[2], String(server.address().port));
});
`;

/** A "suite" that issues one RunQuery over raw HTTP/2, so the check needs no Firestore client. */
const SUITE = `
import { connect } from 'node:http2';
const message = Buffer.from(process.env.PROBE_MESSAGE, 'base64');
const header = Buffer.alloc(5);
header.writeUInt32BE(message.length, 1);
const client = connect('http://' + process.env.FIRESTORE_EMULATOR_HOST);
const request = client.request({
  ':method': 'POST',
  ':path': '/google.firestore.v1.Firestore/RunQuery',
  'content-type': 'application/grpc',
});
request.resume();
request.on('close', () => client.close());
request.end(Buffer.concat([header, message]));
`;

const EXPECTED_KEY = 'items::COLLECTION_GROUP::AND(sku:EQUAL)::qty:ASCENDING';

withInstalledTarball(packageRoot, ({ files, consumer }) => {
  checkShippedFiles(checker, files, [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
  ]);
  checkDeclaredDependencies(checker, manifest, ['@google-cloud/firestore', 'indexwright']);

  check('the fixture-generating script is not shipped', () => {
    for (const path of files) {
      if (path.startsWith('scripts/')) throw new Error(`${path} is a maintenance script`);
    }
  });

  const bin = join(consumer, 'node_modules', '.bin', 'indexwright-record');

  check('the bin runs and reports a version', () => {
    const version = run(bin, ['--version']).trim();
    if (version !== manifest.version) throw new Error(`got ${version}, expected ${manifest.version}`);
  });

  check('the documented exports entry resolves', () => {
    const probe = join(consumer, 'probe.mjs');
    writeFileSync(
      probe,
      "import { buildCorpus, CORPUS_VERSION, parseCorpus, serialiseCorpus } from '@indexwright/record';\n" +
        'const corpus = buildCorpus([], []);\n' +
        'if (corpus.corpusVersion !== CORPUS_VERSION) throw new Error("version mismatch");\n' +
        'parseCorpus(serialiseCorpus(corpus));\n' +
        'console.log("api ok");\n',
    );
    run(process.execPath, [probe], { cwd: consumer });
  });

  check('reconciliation resolves its indexwright dependency from the installed tree', () => {
    // The workspace resolves `indexwright` through a symlink to packages/indexwright, so a passing
    // typecheck says nothing about whether a consumer gets it. This exercises the dependency SPEC §3
    // predicted through the tarball instead — against the linter packed from *this tree*, not the
    // published one, which is what `alongside` is for. So it proves the two halves work together at
    // the versions being released; it does not prove the declared range resolves to them.
    const probe = join(consumer, 'reconcile.mjs');
    writeFileSync(
      probe,
      "import { analyse } from 'indexwright';\n" +
        "import { isVouched, reconcile } from '@indexwright/record';\n" +
        "const candidate = analyse({ indexes: [{ collectionGroup: 'items', queryScope: 'COLLECTION', fields: [{ fieldPath: 'sku', order: 'ASCENDING' }] }] });\n" +
        "const live = [{ name: 'projects/p/databases/(default)/collectionGroups/items/indexes/ix', state: 'READY', queryScope: 'COLLECTION', fields: [{ fieldPath: 'sku', order: 'ASCENDING' }, { fieldPath: '__name__', order: 'ASCENDING' }] }];\n" +
        'const result = reconcile(candidate, live);\n' +
        'if (!isVouched(result)) throw new Error("expected the set to reconcile: " + result.verdict);\n' +
        'if (reconcile(candidate, []).verdict !== "diverged") throw new Error("expected an empty target to diverge");\n' +
        'console.log("reconcile ok");\n',
    );
    run(process.execPath, [probe], { cwd: consumer });
  });

  check('the installed bin captures a query end to end', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'indexwright-record-verify-'));
    let upstream;
    try {
      const stubPath = join(workspace, 'upstream.mjs');
      const suitePath = join(workspace, 'suite.mjs');
      const portPath = join(workspace, 'port');
      writeFileSync(stubPath, STUB_UPSTREAM);
      writeFileSync(suitePath, SUITE);

      upstream = spawn(process.execPath, [stubPath, portPath], { stdio: 'inherit' });
      const port = waitForPort(portPath);

      const fixture = JSON.parse(
        readFileSync(join(packageRoot, 'test', 'fixtures', 'run-query.json'), 'utf8'),
      );
      const probe = fixture.cases.find((entry) => entry.name === 'a collection group query');
      if (probe === undefined) throw new Error('the fixture this check reads is missing');

      const out = join(workspace, 'firestore.queries.json');
      run(bin, ['--emulator', `127.0.0.1:${port}`, '--out', out, '--', process.execPath, suitePath], {
        cwd: workspace,
        env: { ...process.env, PROBE_MESSAGE: probe.message },
        stdio: 'pipe',
      });

      const keys = JSON.parse(readFileSync(out, 'utf8')).queries.map((query) => query.key);
      if (keys.length !== 1 || keys[0] !== EXPECTED_KEY) {
        throw new Error(`unexpected corpus: ${JSON.stringify(keys)}`);
      }
    } finally {
      upstream?.kill();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}, { alongside: [linterRoot] });

/** Block until the stub has written the port it bound, or give up. */
function waitForPort(portPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(portPath)) {
      const value = readFileSync(portPath, 'utf8').trim();
      if (value.length > 0) return Number(value);
    }
    sleep(25);
  }
  throw new Error('the stub upstream never reported a port');
}

/** A synchronous sleep, so this stays in step with the `execFileSync` checks around it. */
function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

finish(checker);
