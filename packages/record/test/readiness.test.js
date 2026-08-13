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
    assert.throws(() => new ReadinessGate(bad), RangeError, String(bad));
  }
});

test('the default settling period errs long', () => {
  // Not a measured bound — the transient window was observed but never timed. Pinned so that
  // shortening it has to be a deliberate edit rather than a drift.
  assert.equal(DEFAULT_SETTLE_MS, 60_000);
  assert.equal(new ReadinessGate().observe([ready('a')], 0).remainingMs, DEFAULT_SETTLE_MS);
});
