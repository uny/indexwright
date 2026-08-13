import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyHost,
  EndpointError,
  isLoopbackHost,
  requireLoopbackBind,
  requireLoopbackUpstream,
} from '../dist/index.js';
import { ALLOW_REMOTE_EMULATOR, parseArgs, UsageError } from '../dist/args.js';
import { startCapture } from '../dist/proxy.js';
import { createServer } from 'node:net';

test('the whole of 127.0.0.0/8 is loopback, not just 127.0.0.1', () => {
  // 127.0.0.2 is a real thing to bind to, and a check that only knew the one address would refuse it
  // while refusing nothing that matters.
  for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.255']) {
    assert.equal(classifyHost(host), 'loopback', host);
  }
});

test('an octet out of range is not read as an address at all', () => {
  // `127.999.0.1` is not loopback because it is not an address; classifying it by its first octet
  // would extend the trust to a string that never resolves.
  for (const host of ['127.999.0.1', '127.0.0.256', '127.0.0']) {
    assert.equal(classifyHost(host), 'remote', host);
  }
});

test('the IPv6 loopback is recognised in the spellings a socket answers with', () => {
  for (const host of ['::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(classifyHost(host), 'loopback', host);
  }
});

test('an IPv4-mapped address that is not loopback stays remote', () => {
  assert.equal(classifyHost('::ffff:10.0.0.1'), 'remote');
  assert.equal(classifyHost('::ffff:0a00:1'), 'remote');
});

test('localhost is trusted by name, in the spellings that resolve the same', () => {
  // Trusted by convention rather than verified: /etc/hosts can repoint it. Refusing the name would
  // reject the commonest spelling of the safe case, including this package's own vocabulary.
  for (const host of ['localhost', 'LocalHost', 'localhost.', '[localhost]', ' localhost ']) {
    assert.equal(classifyHost(host), 'loopback', JSON.stringify(host));
  }
});

test('a name that merely contains localhost is not loopback', () => {
  // The check is equality, not substring. `localhost.evil.example` resolves wherever its owner says.
  for (const host of ['localhost.evil.example', 'notlocalhost', 'localhost-1']) {
    assert.equal(classifyHost(host), 'remote', host);
  }
});

test('a wildcard is classified apart from a routable address', () => {
  // Not a pedantic distinction: it is the case reached by habit, and the one whose consequence is
  // strongest, so the refusal says something different about it.
  for (const host of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']) {
    assert.equal(classifyHost(host), 'wildcard', host);
  }
  for (const host of ['10.0.0.1', '192.168.1.5', 'firestore', 'emulator.internal']) {
    assert.equal(classifyHost(host), 'remote', host);
  }
});

test('isLoopbackHost admits only the loopback class, so a wildcard is never loopback', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('10.0.0.1'), false);
});

test('a loopback upstream passes and a remote one is refused', () => {
  const origin = { kind: 'flag', option: '--emulator' };
  assert.doesNotThrow(() =>
    requireLoopbackUpstream({ host: '127.0.0.1', origin, override: '--allow' }),
  );
  assert.throws(
    () => requireLoopbackUpstream({ host: '10.0.0.1', origin, override: '--allow' }),
    EndpointError,
  );
});

test('the refusal names where the value came from, because the ambient case is the dangerous one', () => {
  // A run that inherits FIRESTORE_EMULATOR_HOST looks, from the command line, exactly like a run
  // against the default. Naming the variable is the difference between fixing it and overriding it.
  assert.throws(
    () =>
      requireLoopbackUpstream({
        host: '10.0.0.1',
        origin: { kind: 'env', variable: 'FIRESTORE_EMULATOR_HOST' },
        override: '--allow-remote-emulator',
      }),
    (error) =>
      /FIRESTORE_EMULATOR_HOST is set to "10\.0\.0\.1"/.test(error.message) &&
      /--allow-remote-emulator/.test(error.message),
  );
  assert.throws(
    () =>
      requireLoopbackUpstream({
        host: '10.0.0.1',
        origin: { kind: 'flag', option: '--emulator' },
        override: '--allow',
      }),
    (error) => /--emulator was given "10\.0\.0\.1"/.test(error.message),
  );
  assert.throws(
    () =>
      requireLoopbackUpstream({
        host: '10.0.0.1',
        origin: { kind: 'option', field: 'upstream' },
        override: 'x',
      }),
    (error) => /upstream was passed "10\.0\.0\.1"/.test(error.message),
  );
});

test('when the origin holds more than the host, the message quotes both', () => {
  // FIRESTORE_EMULATOR_HOST holds host:port. A message quoting only the host would be saying
  // something untrue about what the variable contains, and looking at it is the reader's next move.
  assert.throws(
    () =>
      requireLoopbackUpstream({
        host: 'firestore',
        value: 'firestore:8080',
        origin: { kind: 'env', variable: 'FIRESTORE_EMULATOR_HOST' },
        override: '--allow-remote-emulator',
      }),
    (error) =>
      /is set to "firestore:8080"/.test(error.message) &&
      /whose host "firestore" is not on this machine/.test(error.message),
  );
});

test('an explicit opt-in is what makes a remote endpoint pass, and only then', () => {
  const origin = { kind: 'option', field: 'upstream' };
  const check = { host: '10.0.0.1', origin, override: 'x' };
  assert.throws(() => requireLoopbackUpstream(check), EndpointError);
  assert.throws(() => requireLoopbackUpstream({ ...check, allowed: false }), EndpointError);
  assert.doesNotThrow(() => requireLoopbackUpstream({ ...check, allowed: true }));
});

test('a wildcard bind is refused with the consequence that belongs to a wildcard', () => {
  const origin = { kind: 'option', field: 'host' };
  assert.throws(
    () => requireLoopbackBind({ host: '0.0.0.0', origin, override: 'allowRemoteBind: true' }),
    (error) => /anyone who can reach the port/.test(error.message),
  );
  assert.throws(
    () => requireLoopbackBind({ host: '10.0.0.1', origin, override: 'allowRemoteBind: true' }),
    (error) => /from off this host/.test(error.message),
  );
});

test('parseArgs refuses an inherited non-loopback emulator before anything starts', () => {
  // The hole this closes: the value arrives from the environment, so nobody typed it, and the proxy
  // would forward whatever documents and credentials that upstream holds.
  assert.throws(
    () => parseArgs(['--', 'true'], { FIRESTORE_EMULATOR_HOST: 'firestore:8080' }),
    (error) =>
      error instanceof UsageError &&
      /FIRESTORE_EMULATOR_HOST is set to "firestore:8080"/.test(error.message),
  );
});

test('a non-loopback emulator given on the command line is refused too', () => {
  assert.throws(
    () => parseArgs(['--emulator', '10.0.0.1:8080', '--', 'true'], {}),
    (error) =>
      error instanceof UsageError && /--emulator was given "10\.0\.0\.1:8080"/.test(error.message),
  );
});

test('the override flag lets it through, and is reported so the proxy sees the same answer', () => {
  const command = parseArgs([ALLOW_REMOTE_EMULATOR, '--emulator', '10.0.0.1:8080', '--', 'true'], {});
  assert.equal(command.emulator, '10.0.0.1:8080');
  assert.equal(command.allowRemoteUpstream, true);
});

test('a loopback run does not need the flag and does not claim to have had it', () => {
  const command = parseArgs(['--', 'true'], {});
  assert.equal(command.emulator, '127.0.0.1:8080');
  assert.equal(command.allowRemoteUpstream, false);
});

test('the flag is order-independent, so it works before or after the value it permits', () => {
  assert.equal(
    parseArgs(['--emulator', '10.0.0.1:8080', ALLOW_REMOTE_EMULATOR, '--', 'true'], {}).emulator,
    '10.0.0.1:8080',
  );
});

test('a malformed emulator is reported as malformed rather than as not-loopback', () => {
  // Both are true of "nonsense", and only one of them tells the caller what to fix.
  assert.throws(
    () => parseArgs(['--emulator', 'nonsense', '--', 'true'], {}),
    (error) => error instanceof UsageError && /expected host:port/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--emulator', '::1:8080', '--', 'true'], {}),
    (error) => /IPv6 literal in brackets/.test(error.message),
  );
});

test('an IPv6 loopback emulator is accepted when bracketed, as the proxy requires', () => {
  assert.equal(parseArgs(['--emulator', '[::1]:8080', '--', 'true'], {}).emulator, '[::1]:8080');
});

test('the usage text documents the override and says the bind is not configurable', async () => {
  const { usage } = await import('../dist/args.js');
  const text = usage();
  assert.match(text, /--allow-remote-emulator/);
  assert.match(text, /always listens on loopback/);
});

test('startCapture refuses a remote upstream, and opens nothing when it does', async () => {
  await assert.rejects(() => startCapture({ upstream: '10.0.0.1:8080' }), EndpointError);
});

test('startCapture refuses a non-loopback bind, and opens nothing when it does', async () => {
  // Refused before the listener exists. A refusal that arrived afterwards would already have
  // published the port it was refusing to publish.
  await assert.rejects(
    () => startCapture({ upstream: '127.0.0.1:8080', host: '0.0.0.0' }),
    EndpointError,
  );
});

test('startCapture still binds loopback by default, and still accepts an explicit loopback host', async () => {
  for (const options of [{ upstream: '127.0.0.1:8080' }, { upstream: '127.0.0.1:8080', host: '127.0.0.1' }]) {
    const capture = await startCapture(options);
    try {
      assert.match(capture.address, /^127\.0\.0\.1:\d+$/);
    } finally {
      await capture.close();
    }
  }
});

test('the opt-ins are per endpoint, so permitting one does not permit the other', async () => {
  await assert.rejects(
    () => startCapture({ upstream: '10.0.0.1:8080', allowRemoteBind: true }),
    EndpointError,
  );
  await assert.rejects(
    () => startCapture({ upstream: '127.0.0.1:8080', host: '0.0.0.0', allowRemoteUpstream: true }),
    EndpointError,
  );
});

/** A port nothing is listening on, obtained by holding one and letting it go. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('a refused bind leaves the port genuinely unbound, not merely reported as refused', async () => {
  // The rejection type alone would still pass if the guard ran *after* tcp.listen — which is the one
  // ordering the guard exists to prevent, since it would publish the port it is refusing to publish.
  // So the assertion is on the port itself: after the refusal, we must be able to take it.
  const port = await freePort();
  await assert.rejects(
    () => startCapture({ upstream: '127.0.0.1:8080', host: '0.0.0.0', port }),
    EndpointError,
  );

  const claim = createServer();
  try {
    await new Promise((resolve, reject) => {
      claim.once('error', reject);
      claim.listen(port, '0.0.0.0', resolve);
    });
  } finally {
    await new Promise((resolve) => claim.close(resolve));
  }
});

test('allowRemoteUpstream is load-bearing: it is what lets a remote upstream through', async () => {
  // Without this the override could be deleted and every test would still pass, while the CLI's one
  // advertised escape hatch — `--allow-remote-emulator --emulator firestore:8080` — died with exit 2.
  // `connect` is lazy, so no remote host has to exist for the permitted path to be observable.
  const capture = await startCapture({
    upstream: '10.0.0.1:8080',
    allowRemoteUpstream: true,
    onWarning: () => {},
  });
  try {
    assert.match(capture.address, /^127\.0\.0\.1:\d+$/);
  } finally {
    await capture.close();
  }
});

test('allowRemoteBind is load-bearing: it is what lets a non-loopback bind through', async () => {
  // Binds every interface for the lifetime of this assertion, which is what the option means; it is
  // closed immediately, and it is the only way to show the opt-in actually reaches the decision.
  const capture = await startCapture({
    upstream: '127.0.0.1:8080',
    host: '0.0.0.0',
    allowRemoteBind: true,
    onWarning: () => {},
  });
  try {
    assert.match(capture.address, /^0\.0\.0\.0:\d+$/);
  } finally {
    await capture.close();
  }
});

test('the override flag takes no value, so a value that reads as "off" cannot turn it on', () => {
  // `--allow-remote-emulator=false` would otherwise enable the guard's own override: the parser
  // splits the `=` off before matching the name, so the value was accepted and discarded.
  for (const spelling of [`${ALLOW_REMOTE_EMULATOR}=false`, `${ALLOW_REMOTE_EMULATOR}=0`, `${ALLOW_REMOTE_EMULATOR}=`]) {
    assert.throws(
      () => parseArgs([spelling, '--emulator', '10.0.0.1:8080', '--', 'true'], {}),
      (error) => error instanceof UsageError && /takes no value/.test(error.message),
      spelling,
    );
  }
});

test('a malformed address is blamed on the input that actually carried it', () => {
  // The flag is named when the flag carried it, and the variable when the environment did. Blaming
  // `--emulator` for an inherited value sends the reader to a flag that is not on their command line.
  assert.throws(
    () => parseArgs(['--', 'true'], { FIRESTORE_EMULATOR_HOST: 'firestore' }),
    (error) =>
      error instanceof UsageError &&
      /^FIRESTORE_EMULATOR_HOST: expected host:port/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--emulator', 'firestore', '--', 'true'], {}),
    (error) => error instanceof UsageError && /^--emulator: expected host:port/.test(error.message),
  );
});

test('the override also permits an upstream that arrived from the environment', () => {
  // The origin decides the message, never whether the override applies — a compose-set variable is
  // exactly the case the override documents.
  const command = parseArgs([ALLOW_REMOTE_EMULATOR, '--', 'true'], {
    FIRESTORE_EMULATOR_HOST: 'firestore:8080',
  });
  assert.equal(command.emulator, 'firestore:8080');
  assert.equal(command.allowRemoteUpstream, true);
});
