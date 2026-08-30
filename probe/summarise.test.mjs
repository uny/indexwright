/**
 * The stop rule, tested.
 *
 * `differential.mjs` gates the measured run: an operator reads its exit code three minutes before a
 * deploy that costs three and a half. Two of its four documented stop conditions used to be carried
 * by the summary text alone and exited 0, so this file's subject is mostly the two that now are.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarise, summaryLines } from './summarise.mjs';

const SHAPES = [{ id: 'S1' }, { id: 'S2' }];
const row = (shape, variant, verdict, extra = {}) => ({ shape, variant, verdict, ...extra });

/** Two shapes, every operand agreeing, nothing dropped: the reading a clean run produces. */
function clean() {
  return [
    row('S1', 'sentinel', 'uncovered'),
    row('S1', 'number', 'uncovered'),
    row('S2', 'sentinel', 'served'),
    row('S2', 'number', 'served'),
  ];
}

test('a run where every operand agrees is constant, and exits 0', () => {
  const { findings, exitCode } = summarise(clean(), SHAPES);
  assert.equal(exitCode, 0);
  assert.deepEqual(
    findings.map((f) => [f.shape, f.kind, f.verdict]),
    [
      ['S1', 'constant', 'uncovered'],
      ['S2', 'constant', 'served'],
    ],
  );
  // The count and the number issued are both reported, so a reader has something to compare against.
  assert.equal(findings[0].variants, 2);
  assert.equal(findings[0].issued, 2);
});

test('operands disagreeing within a shape falsifies the claim, and exits 1', () => {
  const results = clean();
  results[1] = row('S1', 'number', 'served');
  const { exitCode, falsified } = summarise(results, SHAPES);
  assert.equal(exitCode, 1);
  assert.equal(falsified.length, 1);
  // The per-variant mapping is what says which direction the failure runs in, so it must survive.
  assert.deepEqual(falsified[0].byVariant, { sentinel: 'uncovered', number: 'served' });
});

test('an INVALID_ARGUMENT row drops out of the comparison without failing the run', () => {
  // The deterministic exclusion: some operands are refused by the backend whatever the index set is,
  // and treating that as a failure would stop a correct run on every execution.
  const results = [...clean(), row('S1', 'map', 'invalid', { message: 'bad operand' })];
  const { exitCode, findings, unreliable } = summarise(results, SHAPES);
  assert.equal(exitCode, 0);
  assert.equal(unreliable.length, 0);
  const s1 = findings.find((f) => f.shape === 'S1');
  // Reported as 2 of 3, which is the whole point: the shortfall is visible rather than implied.
  assert.equal(s1.variants, 2);
  assert.equal(s1.issued, 3);
  assert.match(summaryLines({ findings, unreliable, unexpected: [] })[0], /constant across 2 of 3 operands.*SHORT/);
});

test('a transient failure no longer hides behind a constant verdict', () => {
  // The condition the exit status did not use to carry. `other` is a gRPC status this instrument
  // could not interpret; it shrinks the evidence for the shape while the shape still reads
  // `constant`, which is a verdict over some operands presented as one over all of them.
  for (const verdict of ['other', 'unbuildable']) {
    const results = [...clean(), row('S1', 'timestamp', verdict, { message: 'boom' })];
    const { exitCode, unreliable, findings } = summarise(results, SHAPES);
    assert.equal(exitCode, 2, `${verdict} must exit 2`);
    assert.equal(unreliable.length, 1);
    // Still constant, and that is exactly why the exit code has to carry it: the line reads fine.
    assert.equal(findings.find((f) => f.shape === 'S1').kind, 'constant');
    assert.match(summaryLines({ findings, unreliable, unexpected: [] }).join('\n'), /did not enter the comparison/);
  }
});

test('2 outranks 1 when a run both falsifies the claim and drops an operand', () => {
  const results = [...clean(), row('S2', 'timestamp', 'other', { message: 'boom' })];
  results[1] = row('S1', 'number', 'served');
  const { exitCode, falsified, unreliable } = summarise(results, SHAPES);
  assert.equal(falsified.length, 1);
  assert.equal(unreliable.length, 1);
  // An incomplete run is not a definitive one with a caveat, whichever finding it also carries.
  assert.equal(exitCode, 2);
});

test('a shape answering against a supplied expectation exits 2', () => {
  // The other condition the exit status did not use to carry. A bare target that serves S1 was not
  // bare, so every reading taken from it is of some other index set — not a verdict about §7.
  const expected = new Map([['S1', 'uncovered'], ['S2', 'served']]);
  const ok = summarise(clean(), SHAPES, expected);
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(ok.unexpected, []);

  const results = clean();
  results[0] = row('S1', 'sentinel', 'served');
  results[1] = row('S1', 'number', 'served');
  const bad = summarise(results, SHAPES, expected);
  assert.equal(bad.exitCode, 2);
  assert.deepEqual(bad.unexpected, [{ shape: 'S1', expected: 'uncovered', actual: 'served' }]);
  assert.match(summaryLines(bad).join('\n'), /S1 AGAINST EXPECTATION — expected uncovered, answered served/);
});

test('a shape named by no expectation is unconstrained, whichever way it lands', () => {
  // S2 and S5 in the real run: Firestore may merge single-field indexes for equality-only shapes, so
  // predicting them either way would stop a correct run. An empty expectation must not imply one.
  const expected = new Map([['S1', 'uncovered']]);
  for (const verdict of ['served', 'uncovered']) {
    const results = clean();
    results[2] = row('S2', 'sentinel', verdict);
    results[3] = row('S2', 'number', verdict);
    assert.equal(summarise(results, SHAPES, expected).exitCode, 0, `S2 ${verdict} must not fail`);
  }
});

test('an expectation is not checked against a shape that already failed on its own terms', () => {
  // Reporting a falsified shape a second time as "against expectation" buries the finding that
  // matters under a consequence of it, and would report exit 2 where the claim itself is the news.
  const results = clean();
  results[1] = row('S1', 'number', 'served');
  const { exitCode, unexpected } = summarise(results, SHAPES, new Map([['S1', 'uncovered']]));
  assert.deepEqual(unexpected, []);
  assert.equal(exitCode, 1);
});

test('a shape with fewer than two comparable operands is untested, not constant', () => {
  const results = [row('S1', 'sentinel', 'uncovered'), row('S2', 'sentinel', 'served'), row('S2', 'number', 'served')];
  const { exitCode, untested } = summarise(results, SHAPES);
  assert.equal(exitCode, 2);
  assert.deepEqual(untested.map((f) => f.shape), ['S1']);
});

test('a shape whose every filter is unary is not counted as a hole', () => {
  // `varies: 'nothing'` says the question does not arise, which is different from unanswered. No
  // shape currently sets it — S5 wrongly did — so this pins the branch against a future one.
  const shapes = [{ id: 'S1', varies: 'nothing' }];
  const { exitCode, findings, untested } = summarise([row('S1', 'sentinel', 'served')], shapes);
  assert.equal(exitCode, 0);
  assert.deepEqual(untested, []);
  assert.equal(findings[0].kind, 'not-applicable');
});
