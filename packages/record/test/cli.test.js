import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCorpus, parseCorpus, serialiseCorpus, toQueryShape } from '../dist/index.js';
import { canonicalTarget, parseArgs, UsageError } from '../dist/args.js';
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

test('check names its target in full, and defaults only the file paths', () => {
  const command = parseArgs(['check', '--project', 'p-1', '--database', '(default)']);
  assert.equal(command.kind, 'check');
  assert.equal(command.project, 'p-1');
  assert.equal(command.database, '(default)');
  assert.equal(command.corpus, 'firestore.queries.json');
  assert.equal(command.indexes, 'firestore.indexes.json');
  assert.equal(canonicalTarget(command), 'projects/p-1/databases/(default)');
});

test('check refuses a half-named target, and says which half', () => {
  assert.throws(() => parseArgs(['check', '--database', 'd']), (error) => /--project is required/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', 'p']), (error) => /--database is required/.test(error.message));
  assert.throws(() => parseArgs(['check']), UsageError);
});

test('check does not read the target out of the environment', () => {
  // The whole of issue #8: a project inherited from a shell is whatever was last worked against,
  // and a database carrying more indexes than the candidate set reports clean rather than failing.
  const env = { GOOGLE_CLOUD_PROJECT: 'inherited', GCLOUD_PROJECT: 'inherited-too' };
  assert.throws(() => parseArgs(['check', '--database', 'd'], env), (error) => /--project is required/.test(error.message));
  const command = parseArgs(['check', '--project', 'named', '--database', 'd'], env);
  assert.equal(command.project, 'named');
});

test('check refuses to run while the emulator variable is set', async () => {
  // Issue #37, and the other half of #8 rather than a separate concern: #8 closed the case where the
  // target is inferred, and this is the one where it is named correctly and then quietly not used.
  // The client honours the variable whatever it was constructed with, and an emulator enforces no
  // composite index at all — so the run would announce the named database and report that the
  // candidate set covers every query, having measured nothing.
  const env = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
  assert.throws(
    () => parseArgs(['check', '--project', 'acme-prod', '--database', '(default)'], env),
    (error) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /FIRESTORE_EMULATOR_HOST is set to "127\.0\.0\.1:8080"/);
      // The target is in the message because the variable alone does not say what is wrong: what is
      // wrong is that this database would be announced and a different one measured.
      assert.match(error.message, /projects\/acme-prod\/databases\/\(default\) would be announced/);
      return true;
    },
  );

  // Set to nothing is not set: a client tests it for truthiness, so refusing it here would refuse a
  // shell that exports the variable empty to disable exactly this redirect.
  assert.equal(parseArgs(['check', '--project', 'p', '--database', 'd'], { FIRESTORE_EMULATOR_HOST: '' }).kind, 'check');

  // Refused after the command line is read, so the message an operator gets first is the one about
  // what they typed. Fixing the environment for a half-named target would only earn the other error.
  assert.throws(() => parseArgs(['check', '--database', 'd'], env), (error) => /--project is required/.test(error.message));
  // And the questions that reach no database are still answered.
  assert.equal(parseArgs(['check', '--help'], env).kind, 'help');
  assert.equal(parseArgs(['check', '--version'], env).kind, 'version');

  // The value is written back with the same escaping the target gets, and for the same reason: this
  // message is printed beside the line naming the target, so a value forging a line would forge one.
  assert.throws(
    () => parseArgs(['check', '--project', 'p', '--database', 'd'], { FIRESTORE_EMULATOR_HOST: 'h\nindexwright-record: target projects/decoy/databases/(default)' }),
    // Escaped as `\\u000a` rather than as `\\n`: `render` writes every non-printable back as its
    // code point, so the forged line arrives as text that cannot itself break a line.
    (error) => /"h\\u000aindexwright-record: target projects\/decoy/.test(error.message),
  );

  // End to end, it is exit 2 and the refusal on stderr — not a run that reaches a client.
  const streams = collect();
  assert.equal(await run(['check', '--project', 'acme-prod', '--database', '(default)'], streams, env), 2);
  assert.match(streams.stderr(), /FIRESTORE_EMULATOR_HOST is set/);
  assert.doesNotMatch(streams.stderr(), /target projects\/acme-prod/);
});

test('check refuses the universe variable too, which redirects the admin client the emulator one does not', () => {
  // The redirect the first version of this guard missed, and the reason the guard is now a list.
  // `FIRESTORE_EMULATOR_HOST` is read by the *data* client; the admin client `check` lists indexes
  // with never reads it, and reads `GOOGLE_CLOUD_UNIVERSE_DOMAIN` instead, turning it into
  // `firestore.{value}` as the service path. Nothing downstream objects — gax validates a universe
  // domain against its own default, not against the path the client already built — so the run
  // announces the named database and lists somebody else's, which is #8's clean report exactly.
  const env = { GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'other.example' };
  assert.throws(
    () => parseArgs(['check', '--project', 'acme-prod', '--database', '(default)'], env),
    (error) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /GOOGLE_CLOUD_UNIVERSE_DOMAIN is set to "other\.example"/);
      assert.match(error.message, /projects\/acme-prod\/databases\/\(default\) would be announced/);
      // The consequence is named, and it is not the emulator's: no report of clean replay, but a
      // listing that came from another service entirely.
      assert.match(error.message, /listing would come from another service/);
      return true;
    },
  );

  // Set to nothing is not set, and here for a different reason than the emulator variable: an empty
  // universe domain is not coalesced to `googleapis.com`, it builds the service path `firestore.`,
  // which does not resolve. That is a connection error — loud, and so not this guard's business.
  assert.equal(parseArgs(['check', '--project', 'p', '--database', 'd'], { GOOGLE_CLOUD_UNIVERSE_DOMAIN: '' }).kind, 'check');

  // Both at once names the emulator, because it is refused first — one refusal, not a list to work
  // through, and the operator unsets one variable and gets the next message if there is one.
  assert.throws(
    () => parseArgs(['check', '--project', 'p', '--database', 'd'], {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'other.example',
    }),
    (error) => /FIRESTORE_EMULATOR_HOST is set/.test(error.message),
  );

  // Escaped like every other value written back beside the target line.
  assert.throws(
    () => parseArgs(['check', '--project', 'p', '--database', 'd'], { GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'h\nindexwright-record: target projects/decoy/databases/(default)' }),
    (error) => /"h\\u000aindexwright-record: target projects\/decoy/.test(error.message),
  );
});

test('every target a real Firestore id can be is accepted', () => {
  // The allowlist has to be wider than Google's own rules, or a required argument with no fallback
  // has a spelling it refuses and no way around. `(default)` is the case that needs the parentheses,
  // and `google.com:my-app` — the legacy domain-scoped form — is why the project half takes a colon.
  for (const [project, database] of [
    ['acme-prod', '(default)'],
    ['p-1', 'db-7'],
    ['my_project.v2', 'a.b-c'],
    ['abc123', 'x'.repeat(63)],
    ['google.com:my-app', '(default)'],
  ]) {
    const command = parseArgs(['check', '--project', project, '--database', database]);
    assert.equal(canonicalTarget(command), `projects/${project}/databases/${database}`);
  }
});

test('the database half does not take the colon the project half does', () => {
  // `…/databases/{database}` is the last segment before a `:customMethod` suffix, so a colon there
  // could name an operation rather than a database. Mid-path, in the project, it cannot.
  assert.throws(
    () => parseArgs(['check', '--project', 'p', '--database', 'd:exportDocuments']),
    (error) => /may hold only/.test(error.message),
  );
});

test('a refused value is rendered, not reprinted, even where the allowlist is not the filter', () => {
  // The forgery sweep alone would still pass if `render` were removed, because every value it uses
  // also fails the allowlist and that message could simply omit the value. The leading-`-` branch is
  // the one that carries a value into a message without the allowlist having vetted it.
  assert.throws(
    () => parseArgs(['check', '--project', 'p', '--database', '-a\u2028b']),
    (error) =>
      /--database needs a value/.test(error.message) &&
      error.message.includes('\\u2028') &&
      ![...error.message].some((c) => (c.codePointAt(0) ?? 0) < 0x20 || (c.codePointAt(0) ?? 0) > 0x7e),
  );
  // Past the BMP the escape is braced, so it stays a single unambiguous escape.
  assert.throws(
    () => parseArgs(['check', '--project', 'p', '--database', '-a\u{1f600}b']),
    (error) => error.message.includes('\\u{1f600}'),
  );
});

test('a target segment that would address something else is refused', () => {
  // Both halves go into `projects/{p}/databases/{d}` and then into a URL, so the test is whether the
  // value still names what it appears to name after a URL layer has seen it — not whether it holds
  // some particular forbidden character. A backslash is folded to a slash by the WHATWG parser and
  // then resolved, so `throwaway\..\prod` echoes as itself and requests `prod`.
  for (const bad of ['a/b', 'throwaway\\..\\prod', 'safe?x=1', 'a#b', '%2e%2e', 'a b']) {
    assert.throws(() => parseArgs(['check', '--project', 'p', '--database', bad]), (error) => /may hold only/.test(error.message));
    assert.throws(() => parseArgs(['check', '--project', bad, '--database', 'd']), (error) => /may hold only/.test(error.message));
  }
  // Dot segments collapse on their own, without needing a separator of their own.
  assert.throws(() => parseArgs(['check', '--project', '..', '--database', 'd']), (error) => /cannot be "\.\."/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', '.', '--database', 'd']), (error) => /cannot be "\."/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project=', '--database', 'd']), (error) => /--project needs a value/.test(error.message));
});

test('a target segment cannot forge a line of the announcement', () => {
  // `cli.ts` prints the target as the one line a run has to say out loud, so a newline in a segment
  // writes a second `indexwright-record:` line beside it naming a database nobody targeted, and a
  // carriage return overwrites the real one in place. U+0085 and U+2028 are line breaks to plenty of
  // viewers, and the bidi overrides reorder a name without altering a character of it.
  const forged = `scratch-db\nindexwright-record: check complete, 0 unserved queries`;
  for (const bad of [forged, 'safe\r\x1b[2K', 'safe\u0085x', 'a\u2028b', 'safe\u202edorp']) {
    assert.throws(() => parseArgs(['check', '--project', 'p', '--database', bad]), (error) => /may hold only/.test(error.message));
    // And the refusal must not reprint what it just refused: the message that names a value which
    // could forge a line cannot be the thing that forges one. `JSON.stringify` alone does not do
    // this — it leaves U+0085 and U+2028 raw.
    assert.throws(
      () => parseArgs(['check', '--project', 'p', '--database', bad]),
      (error) => ![...error.message].some((c) => (c.codePointAt(0) ?? 0) < 0x20 || (c.codePointAt(0) ?? 0) > 0x7e),
    );
  }
});

test('an option absorbed as a value is a usage error, not a value', () => {
  // `--database --corpus` is a missing value, not a database named `--corpus`. Left unrefused it
  // reaches the echo as a target the user never typed — and on a file path it fails much later,
  // somewhere that can no longer say which option was written without its argument.
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', '--corpus']), (error) => /--database needs a value/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', '--database', '--corpus', 'c.json']), (error) => /--project needs a value/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', 'd', '--corpus', '--indexes']), (error) => /--corpus needs a value/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', 'd', '--indexes', '--corpus']), (error) => /--indexes needs a value/.test(error.message));
});

test('--help and --version sitting where a value belongs are the missing value, not a request', () => {
  // Scanned ahead of the option loop, `check --database --version` printed the version and exited 0
  // — a success for a command line that named no database. They are answered inside the loop, so a
  // token in value position is never read as a request about the binary.
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', '--version']), (error) => /--database needs a value/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', '--help']), (error) => /--database needs a value/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', 'd', '--corpus', '--help']), (error) => /--corpus needs a value/.test(error.message));
  // Still answered wherever they are genuinely an argument of their own.
  assert.equal(parseArgs(['check', '--project', 'p', '--help']).kind, 'help');
  assert.equal(parseArgs(['check', '--version']).kind, 'version');
});

test('a file path option that was written empty is a usage error', () => {
  // `resolve('')` is the working directory, so an empty `--corpus` reads as a request to open a
  // directory as a corpus rather than as the typo it is.
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', 'd', '--corpus=']), (error) => /--corpus needs a value/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', 'd', '--indexes=']), (error) => /--indexes needs a value/.test(error.message));
  // `parseCheck` carries its own `takeValue`, so the trailing-flag case is its own path.
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', 'd', '--corpus']), (error) => /--corpus needs a value/.test(error.message));
});

test('check takes its options in either form, and refuses ones it does not have', () => {
  const command = parseArgs(['check', '--project=p', '--database=d', '--corpus=c.json', '--indexes=i.json']);
  assert.equal(command.corpus, 'c.json');
  assert.equal(command.indexes, 'i.json');
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', 'd', '--nope']), (error) => /unknown option/.test(error.message));
  assert.throws(() => parseArgs(['check', '--project', 'p', '--database', 'd', 'extra']), (error) => /unexpected argument/.test(error.message));
});

test('check is a verb only as the first word, so a suite of that name still runs', () => {
  const command = parseArgs(['--', 'check', '--project', 'p']);
  assert.equal(command.kind, 'record');
  assert.deepEqual(command.argv, ['check', '--project', 'p']);
});

test('the help says what the verb costs, since that is what a reader cannot check against the code', async () => {
  // The settling period is the surprising part of running this: a `check` that answers in under a
  // minute is a `check` that did not establish readiness. A usage that leaves it out is one a reader
  // discovers by watching a CI job appear to hang.
  const streams = collect();
  assert.equal(await run(['check', '--help'], streams, {}), 0);
  assert.match(streams.stdout(), /takes a minute at the least/);
  // `-h` is documented as check's alias and is answered before the option loop, which would
  // otherwise reject it for not starting with `--`.
  const short = collect();
  assert.equal(await run(['check', '-h'], short, {}), 0);
  assert.match(short.stdout(), /takes a minute at the least/);
});

test('check answers --version, so the flag does not stop working once a verb is named', async () => {
  const streams = collect();
  assert.equal(await run(['check', '--version'], streams, {}), 0);
  assert.match(streams.stdout(), /^\d+\.\d+\.\d+/);
});

test('check prints the target before it could reach a network, and exits non-zero', async () => {
  // Printed on every run rather than only on a failure: a real database in place of a throwaway one
  // is the mistake that produces no error, so the target is the one thing a run has to say out loud.
  const streams = collect();
  // The candidate file is named explicitly and does not exist, which is what makes this a test of
  // the *order*: the verb announces the target, then fails on a file it could read offline, and
  // never builds a client. Named rather than defaulted because the default is resolved against the
  // working directory, and a directory that happened to hold a `firestore.indexes.json` would send
  // this test somewhere else entirely.
  //
  // The exit code is the half a CI step branches on. Unasserted, a verb that regressed to `return 0`
  // would report a replay that never ran as a clean one — the silent pass it exists to prevent.
  const missing = join(mkdtempSync(join(tmpdir(), 'indexwright-')), 'absent.json');
  const argv = ['check', '--project', 'acme-prod', '--database', '(default)', '--indexes', missing];
  assert.equal(await run(argv, streams, {}), 2);
  const [first, second] = streams.stderr().split('\n');
  assert.match(first, /target projects\/acme-prod\/databases\/\(default\)/);
  assert.match(second, /could not read the candidate indexes/);
});

test('check\'s exit code is the one the CLI returns, for each of the three', async () => {
  // The one line of the shipped path that nothing reached: `run` hands `check`'s code back, and
  // every 0/1/2 assertion in the suite lived in `check.test.js`, which calls `check` directly.
  // Replacing that line with `await check(...); return 2` left all 335 tests green — so a corpus
  // fully covered would have reported 2 from the CLI while the library said 0, and a
  // FAILED_PRECONDITION would have lost its distinct 1. Measured, not assumed.
  const live = [
    {
      name: 'projects/p/databases/(default)/collectionGroups/orders/indexes/ix',
      state: 'READY',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: '__name__', order: 'ASCENDING' },
      ],
    },
  ];
  const declared = {
    indexes: [
      {
        collectionGroup: 'orders',
        queryScope: 'COLLECTION',
        fields: [{ fieldPath: 'status', order: 'ASCENDING' }],
      },
    ],
  };
  const corpus = serialiseCorpus(
    buildCorpus(
      [
        toQueryShape({
          collectionGroup: 'orders',
          queryScope: 'COLLECTION',
          where: { op: 'AND', filters: [{ fieldPath: 'status', op: 'EQUAL' }] },
          orderBy: [],
        }),
      ],
      [],
    ),
  );

  for (const [status, expected] of [
    [{ kind: 'served' }, 0],
    [{ kind: 'uncovered', message: '"the query requires an index"' }, 1],
    [{ kind: 'invalid', message: '"inequality on two fields"' }, 2],
  ]) {
    const streams = collect();
    const argv = ['check', '--project', 'p', '--database', '(default)'];
    const code = await run(argv, streams, {}, {
      settleMs: 0,
      now: () => 0,
      sleep: async () => {},
      readFile: (path) => (path === 'firestore.indexes.json' ? JSON.stringify(declared) : corpus),
      lister: async () => ({
        listIndexesAsync: () => (async function* () { for (const i of live) yield i; })(),
        close: async () => {},
      }),
      replayer: async () => ({ run: async () => status, close: async () => {} }),
    });
    assert.equal(code, expected, `${status.kind} should exit ${expected}, said: ${streams.stderr()}`);
  }
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
  // Always passed on, including on a tty where SIGINT is not. No terminal generates a SIGTERM, so
  // declining would lose the case it usually is — one aimed at this process alone, which nothing
  // else will pass on. A process manager that signals the whole group does hand the suite a
  // duplicate here, and nothing at delivery time tells that apart from a targeted one.
  assert.equal(shouldForward('SIGTERM', true), true);
  assert.equal(shouldForward('SIGTERM', false), true);
});

test('an interrupted run still writes the corpus, and exits 130', async () => {
  // Spawned rather than driven through `run()` in-process: the fix installs handlers on `process`,
  // and the thing being asserted is what a real Ctrl-C does to a real recorder — including that it
  // does not take the recorder down before the corpus is written.
  //
  // Read before anything is opened. A throw between `listen` and the `try` below would skip the
  // `finally`, and a listening server is a ref'd handle: a renamed fixture would then arrive as a
  // test file that never exits rather than as the assertion failure it is.
  const { cases } = JSON.parse(
    readFileSync(fileURLToPath(new URL('fixtures/run-query.json', import.meta.url)), 'utf8'),
  );
  const query = cases.find((entry) => entry.name === 'a collection group query');
  assert.ok(query, 'fixture "a collection group query" is missing');

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
    // `detached`, so the recorder leads its own session with no controlling terminal. Without it the
    // test asserts different things depending on where it runs: from a terminal the recorder would
    // inherit that terminal, decide the suite already had the interrupt, and forward nothing — and
    // the suite would then live out its own timer and satisfy every assertion below anyway. It also
    // gives the `finally` a process group to kill, so a failure cannot strand the suite.
    // `recorder.kill` still targets the one pid, which is what makes the forwarding load-bearing.
    { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true },
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
    // Bounded, because the regressions worth catching here are slow rather than wrong. A recorder
    // that stops forwarding leaves the suite to reach its own 30s timer and exit, after which every
    // assertion below still holds; one that stops handling the signal dies at once and leaves the
    // suite holding the inherited stdio this promise waits on. Both are a pass that took half a
    // minute unless the wait itself can fail.
    const { code, signal } = await Promise.race([
      exited,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`the recorder did not exit within 10s of the interrupt\n${stdout}${stderr}`)),
          10_000,
        ).unref();
      }),
    ]);

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
    // The group, not the pid: the suite is a grandchild this test never learns the pid of, and on
    // the failure paths it is still running with the recorder's stdio pipes held open.
    // Guarded on the recorder still running, because `process.kill` has no handle behind it the way
    // `recorder.kill` does: once Node has reaped the recorder its pid is free to be reused, and a
    // raw group kill on a stale pid would go to whatever now holds it. On the passing path there is
    // nothing left to clean up anyway.
    if (recorder.exitCode === null && recorder.signalCode === null) {
      try {
        process.kill(-recorder.pid, 'SIGKILL');
      } catch {
        // Raced with its own exit, which is fine — the point was only not to strand the suite.
      }
    }
    rmSync(directory, { recursive: true, force: true });
    upstream.close();
  }
});

/**
 * A suite that handles the interrupt itself and then reports success.
 *
 * The distinguishing case for the exit code. The querying child above dies *from* the signal, so
 * `close` reports `signal: 'SIGINT'` and the pre-existing `128 + signal` fallback arrives at 130 on
 * its own — the new rule could be deleted and that test would not notice. Here `close` reports a
 * clean `code: 0` and no signal, so 130 can only come from the interrupt having been what ended the
 * run.
 */
const TRAPPING_CHILD = `
process.on('SIGINT', () => {
  // Its own cleanup, on its own terms, and then a verdict of its own.
  setTimeout(() => process.exit(0), 10);
});
// Read by the test as the signal that the handler is installed and it is safe to interrupt.
console.log('trapping');
setTimeout(() => {}, 30_000);
`;

test('a suite that traps the interrupt and exits 0 did not make the run a success', async () => {
  const upstream = createServer();
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-record-'));
  const env = { ...process.env };
  delete env.FIRESTORE_EMULATOR_HOST;

  const recorder = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
      '--emulator',
      `127.0.0.1:${upstream.address().port}`,
      '--out',
      join(directory, 'corpus.json'),
      '--',
      process.execPath,
      '-e',
      TRAPPING_CHILD,
    ],
    // Detached for the same reason as the test above: a controlling terminal would suppress the
    // forward, and the suite would never see the signal it is here to trap.
    { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true },
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
      const timer = setTimeout(() => reject(new Error(`the suite never armed its trap\n${stdout}${stderr}`)), 10_000);
      timer.unref();
      recorder.stdout.on('data', () => {
        if (stdout.includes('trapping')) {
          clearTimeout(timer);
          resolve();
        }
      });
      recorder.on('close', () => reject(new Error(`the recorder exited early\n${stdout}${stderr}`)));
    });

    recorder.kill('SIGINT');
    const { code, signal } = await Promise.race([
      exited,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`the recorder did not exit within 10s of the interrupt\n${stdout}${stderr}`)),
          10_000,
        ).unref();
      }),
    ]);

    assert.equal(signal, null, `the recorder was killed by ${signal} instead of handling it\n${stderr}`);
    assert.equal(code, 130, `the suite exited 0, but the run was interrupted\n${stderr}`);
    assert.match(stderr, /interrupted by SIGINT/);
  } finally {
    // Guarded on the recorder still running, because `process.kill` has no handle behind it the way
    // `recorder.kill` does: once Node has reaped the recorder its pid is free to be reused, and a
    // raw group kill on a stale pid would go to whatever now holds it. On the passing path there is
    // nothing left to clean up anyway.
    if (recorder.exitCode === null && recorder.signalCode === null) {
      try {
        process.kill(-recorder.pid, 'SIGKILL');
      } catch {
        // Raced with its own exit, which is fine — the point was only not to strand the suite.
      }
    }
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
