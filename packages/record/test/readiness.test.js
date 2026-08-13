import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SETTLE_MS,
  INDEX_STATES,
  isReportable,
  isTransient,
  ReadinessGate,
} from '../dist/index.js';

const ready = (name) => ({ name, state: 'READY' });

test('a single all-READY observation is never enough', () => {
  // The failure this gate exists to prevent is a set that looks ready at one instant, so one
  // observation cannot satisfy it however long the process has been running.
  const gate = new ReadinessGate(1000);
  assert.deepEqual(gate.observe([ready('a')], 0), { kind: 'settling', remainingMs: 1000 });
});

test('not even at a zero settling period, where the run still has to be observed twice', () => {
  const gate = new ReadinessGate(0);
  assert.deepEqual(gate.observe([ready('a')], 5), { kind: 'settling', remainingMs: 0 });
  assert.deepEqual(gate.observe([ready('a')], 5), { kind: 'ready' });
});

test('the set becomes reportable once it has been quiet for the settling period', () => {
  const gate = new ReadinessGate(1000);
  gate.observe([ready('a')], 0);
  assert.deepEqual(gate.observe([ready('a')], 999), { kind: 'settling', remainingMs: 1 });
  assert.deepEqual(gate.observe([ready('a')], 1000), { kind: 'ready' });
});

test('a building index restarts the settling period rather than shortening it', () => {
  const gate = new ReadinessGate(1000);
  gate.observe([ready('a')], 0);
  assert.deepEqual(gate.observe([{ name: 'a', state: 'CREATING' }], 500), {
    kind: 'building',
    indexes: ['a'],
  });
  // The 500ms already served is discarded: the run was interrupted, so it was not a run.
  assert.deepEqual(gate.observe([ready('a')], 600), { kind: 'settling', remainingMs: 1000 });
  assert.deepEqual(gate.observe([ready('a')], 1599), { kind: 'settling', remainingMs: 1 });
  assert.deepEqual(gate.observe([ready('a')], 1600), { kind: 'ready' });
});

test('an index appearing restarts the period, because the set itself transitioned', () => {
  // Every index reports READY both before and after, so nothing but the membership changed — and a
  // period that survived it would have been timing a set that no longer exists.
  const gate = new ReadinessGate(1000);
  gate.observe([ready('a')], 0);
  assert.deepEqual(gate.observe([ready('a'), ready('b')], 500), {
    kind: 'settling',
    remainingMs: 1000,
  });
  assert.deepEqual(gate.observe([ready('a'), ready('b')], 1499), {
    kind: 'settling',
    remainingMs: 1,
  });
});

test('an index disappearing restarts it too', () => {
  const gate = new ReadinessGate(1000);
  gate.observe([ready('a'), ready('b')], 0);
  assert.deepEqual(gate.observe([ready('a')], 500), { kind: 'settling', remainingMs: 1000 });
});

test('the same set in a different order is the same set', () => {
  // The Admin API does not promise an order, and a period restarted by a reordered response would
  // never elapse.
  const gate = new ReadinessGate(1000);
  gate.observe([ready('a'), ready('b')], 0);
  assert.deepEqual(gate.observe([ready('b'), ready('a')], 1000), { kind: 'ready' });
});

test('a damaged index is reported as damaged rather than as still building', () => {
  // The distinction is what the caller does next: waiting resolves CREATING and never resolves
  // NEEDS_REPAIR.
  const gate = new ReadinessGate(0);
  const verdict = gate.observe([ready('a'), { name: 'b', state: 'NEEDS_REPAIR' }], 0);
  assert.deepEqual(verdict, { kind: 'damaged', indexes: ['b'] });
  assert.equal(isTransient(verdict), false);
});

test('a state this version cannot classify is refused rather than assumed ready', () => {
  // A state added after this was written has no published meaning here, and the only guess that
  // would let a report out is the guess that it means READY.
  const gate = new ReadinessGate(0);
  const verdict = gate.observe([{ name: 'a', state: 'REBUILDING_SOMEHOW' }], 0);
  assert.deepEqual(verdict, {
    kind: 'unrecognised',
    indexes: ['a'],
    states: ['REBUILDING_SOMEHOW'],
  });
  assert.equal(isTransient(verdict), false);
});

test('STATE_UNSPECIFIED is named by the vocabulary but still not actionable', () => {
  const gate = new ReadinessGate(0);
  assert.ok(INDEX_STATES.includes('STATE_UNSPECIFIED'));
  assert.deepEqual(gate.observe([{ name: 'a', state: 'STATE_UNSPECIFIED' }], 0), {
    kind: 'unrecognised',
    indexes: ['a'],
    states: ['STATE_UNSPECIFIED'],
  });
});

test('every state the vocabulary names is classified, and only READY can lead to a report', () => {
  for (const state of INDEX_STATES) {
    const gate = new ReadinessGate(0);
    gate.observe([{ name: 'a', state }], 0);
    const verdict = gate.observe([{ name: 'a', state }], 0);
    assert.equal(isReportable(verdict), state === 'READY', state);
  }
});

test('an unrecognised state outranks a damaged one in the same response', () => {
  // It says this version may be misreading the API, which is a reason to distrust how every other
  // index in the same response was classified.
  const gate = new ReadinessGate(0);
  const verdict = gate.observe(
    [
      { name: 'a', state: 'NEEDS_REPAIR' },
      { name: 'b', state: 'SOMETHING_NEW' },
    ],
    0,
  );
  assert.equal(verdict.kind, 'unrecognised');
});

test('a damaged index outranks a building one', () => {
  const gate = new ReadinessGate(0);
  const verdict = gate.observe(
    [
      { name: 'a', state: 'CREATING' },
      { name: 'b', state: 'NEEDS_REPAIR' },
    ],
    0,
  );
  assert.equal(verdict.kind, 'damaged');
});

test('offending indexes are named, sorted, and deduplicated by state', () => {
  const gate = new ReadinessGate(0);
  const verdict = gate.observe(
    [
      { name: 'c', state: 'WHO_KNOWS' },
      { name: 'a', state: 'WHO_KNOWS' },
      { name: 'b', state: 'ALSO_NEW' },
    ],
    0,
  );
  assert.deepEqual(verdict.indexes, ['a', 'b', 'c']);
  assert.deepEqual(verdict.states, ['ALSO_NEW', 'WHO_KNOWS']);
});

test('an empty set is vacuously ready, which is a statement about readiness only', () => {
  // A database whose candidate set is empty really has nothing left to build. That a forgotten
  // deploy looks identical is a question about whether the set is present, which this gate does
  // not answer and does not pretend to.
  const gate = new ReadinessGate(0);
  gate.observe([], 0);
  assert.deepEqual(gate.observe([], 0), { kind: 'ready' });
});

test('only building and settling are worth waiting on', () => {
  assert.equal(isTransient({ kind: 'building', indexes: [] }), true);
  assert.equal(isTransient({ kind: 'settling', remainingMs: 1 }), true);
  assert.equal(isTransient({ kind: 'ready' }), false);
  assert.equal(isTransient({ kind: 'damaged', indexes: [] }), false);
  assert.equal(isTransient({ kind: 'unrecognised', indexes: [], states: [] }), false);
});

test('the settling period is rejected rather than silently treated as none', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    // The message is asserted, not just the class: `assert.throws`'s third argument is the label
    // printed when the assertion fails, not a matcher, so a class-only check would still pass if
    // the message stopped naming the value that was rejected.
    assert.throws(() => new ReadinessGate(bad), { name: 'RangeError', message: /got /u }, String(bad));
  }
  // A valid period must not be caught by the same guard.
  assert.doesNotThrow(() => new ReadinessGate(0));
  assert.doesNotThrow(() => new ReadinessGate(0.5));
});

test('a clock reading that is not a number is rejected instead of poisoning the run', () => {
  // `NaN` would anchor the run at `NaN`, every later `elapsed >= settleMs` would be false, and the
  // gate would answer `settling` for the rest of the process — which `isTransient` calls worth
  // waiting on, so a polling caller would never stop and never be told why.
  const gate = new ReadinessGate(1000);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => gate.observe([ready('a')], bad), { name: 'RangeError' }, String(bad));
  }
  // Rejecting it left the gate usable rather than half-updated.
  assert.deepEqual(gate.observe([ready('a')], 0), { kind: 'settling', remainingMs: 1000 });
  assert.deepEqual(gate.observe([ready('a')], 1000), { kind: 'ready' });
});

test('set identity is injective, so no membership change can inherit a running period', () => {
  // A separator-joined identity is only injective if the separator cannot occur in a name. These
  // are the two sets that broke that assumption; both must restart the period rather than finish
  // one that was timing a different set.
  const empty = new ReadinessGate(1000);
  empty.observe([], 0);
  assert.deepEqual(empty.observe([{ name: '', state: 'READY' }], 1000), {
    kind: 'settling',
    remainingMs: 1000,
  });

  const separator = new ReadinessGate(1000);
  const NUL = String.fromCharCode(0);
  separator.observe([ready('a'), ready(`b${NUL}c`)], 0);
  assert.deepEqual(separator.observe([ready(`a${NUL}b`), ready('c')], 1000), {
    kind: 'settling',
    remainingMs: 1000,
  });
});

test('a damaged index restarts the period rather than shortening it', () => {
  // The CREATING path already covers restart-after-interruption; these two pin the other branches
  // that reset, which would otherwise let an interruption *credit* time to the run it interrupted.
  const gate = new ReadinessGate(1000);
  gate.observe([ready('a')], 0);
  assert.equal(gate.observe([{ name: 'a', state: 'NEEDS_REPAIR' }], 500).kind, 'damaged');
  assert.deepEqual(gate.observe([ready('a')], 1000), { kind: 'settling', remainingMs: 1000 });
});

test('an unrecognised state restarts the period too', () => {
  const gate = new ReadinessGate(1000);
  gate.observe([ready('a')], 0);
  assert.equal(gate.observe([{ name: 'a', state: 'SOMETHING_NEW' }], 500).kind, 'unrecognised');
  assert.deepEqual(gate.observe([ready('a')], 1000), { kind: 'settling', remainingMs: 1000 });
});

test('nothing is reportable while the set is still settling', () => {
  // The only verdict that must never be reportable but *looks* benign: every index says READY and
  // only the clock disagrees. Without this, widening `isReportable` to accept `settling` — which is
  // the whole window this module exists to sit out — goes unnoticed.
  const gate = new ReadinessGate(1000);
  const settling = gate.observe([ready('a')], 0);
  assert.equal(settling.kind, 'settling');
  assert.equal(isReportable(settling), false);
  assert.equal(isReportable(gate.observe([ready('a')], 999)), false);
  assert.equal(isReportable(gate.observe([ready('a')], 1000)), true);
});

test('a set that has settled stays ready under continued polling', () => {
  // The caller polls; it does not stop at the first `ready`. A gate that re-anchored the run on
  // each reported `ready` would flap between `ready` and `settling` forever.
  const gate = new ReadinessGate(1000);
  gate.observe([ready('a')], 0);
  assert.deepEqual(gate.observe([ready('a')], 1000), { kind: 'ready' });
  assert.deepEqual(gate.observe([ready('a')], 1500), { kind: 'ready' });
  assert.deepEqual(gate.observe([ready('a')], 9000), { kind: 'ready' });
});

test('a state that is not a string is still reported as one', () => {
  // `states` is declared `readonly string[]`. The gRPC admin client types `Index.state` as a
  // numeric enum, and proto3 JSON omits the field entirely when it is STATE_UNSPECIFIED, so both
  // reach here as non-strings and must not escape into a message as `2` or `undefined`.
  const gate = new ReadinessGate(0);
  assert.deepEqual(gate.observe([{ name: 'a', state: 2 }], 0), {
    kind: 'unrecognised',
    indexes: ['a'],
    states: ['2'],
  });
  const absent = new ReadinessGate(0);
  assert.deepEqual(absent.observe([{ name: 'a' }], 0), {
    kind: 'unrecognised',
    indexes: ['a'],
    states: ['undefined'],
  });
});

test('the default settling period errs long', () => {
  // Not a measured bound — the transient window was observed but never timed. Pinned so that
  // shortening it has to be a deliberate edit rather than a drift.
  assert.equal(DEFAULT_SETTLE_MS, 60_000);
  assert.equal(new ReadinessGate().observe([ready('a')], 0).remainingMs, DEFAULT_SETTLE_MS);
});
