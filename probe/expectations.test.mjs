/**
 * The command line, tested.
 *
 * This is the half of the stop rule that turns what an operator typed into what `summarise.mjs`
 * enforces. Untested, a regression in it leaves an expectation unenforced while the JSON report's
 * `expected` field still claims it was enforced — and the suite stays green, because nothing else
 * ever sees the argv.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError, parseExpectations } from './expectations.mjs';

const IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
const parse = (...argv) => parseExpectations(argv, IDS);
const refuses = (argv, pattern) =>
  assert.throws(() => parseExpectations(argv, IDS), (error) => {
    assert.ok(error instanceof UsageError, `expected UsageError, got ${error?.name}`);
    assert.match(error.message, pattern);
    return true;
  });

test('the runbook step-3 invocation reaches summarise as the map it describes', () => {
  // Verbatim from probe/README.md, because the string an operator types is the thing under test.
  const { positional, expected } = parse(
    'indexwright-probe', '(default)',
    '--expect-uncovered', 'S1,S3,S4,S6,S8',
    '--expect-served', 'S7',
  );
  assert.deepEqual(positional, ['indexwright-probe', '(default)']);
  assert.deepEqual(Object.fromEntries(expected), {
    S1: 'uncovered', S3: 'uncovered', S4: 'uncovered', S6: 'uncovered', S8: 'uncovered', S7: 'served',
  });
  // S2 and S5 unconstrained is not an incidental gap — encoding a prediction for those is the
  // mistake 8709f68 fixed, and it would stop a correct run.
  assert.equal(expected.has('S2'), false);
  assert.equal(expected.has('S5'), false);
});

test('the runbook step-5 invocation inverts cleanly, and the database defaults', () => {
  const { positional, expected } = parse(
    'indexwright-probe',
    '--expect-served', 'S1,S2,S3,S4,S5,S7',
    '--expect-uncovered', 'S6,S8',
  );
  assert.deepEqual(positional, ['indexwright-probe']);
  assert.equal(expected.size, 8);
  assert.equal(expected.get('S2'), 'served');
  assert.equal(expected.get('S6'), 'uncovered');
});

test('an empty list is refused rather than enforcing nothing', () => {
  // `--expect-uncovered "$EXPECT_UNCOVERED"` with the variable unset. Accepted, it would run the
  // whole probe, enforce no expectation, exit 0, and report `"expected": {}` — which reads as
  // "checked, nothing violated" on the one step whose job is to stop a deploy.
  refuses(['p', '--expect-uncovered', ''], /empty list/);
  refuses(['p', '--expect-served', ' , '], /empty list/);
});

test('a flag with no list is refused, including one followed by another flag', () => {
  refuses(['p', '--expect-uncovered'], /needs a comma-separated list/);
  refuses(['p', '--expect-uncovered', '--expect-served', 'S1'], /needs a comma-separated list/);
});

test('an unknown flag is refused rather than read as the project', () => {
  refuses(['--expect-uncoverd', 'S1', 'p'], /not an option this script defines/);
});

test('a shape id that does not exist is refused, because it could never fail', () => {
  refuses(['p', '--expect-uncovered', 'S9'], /S9, which is not a shape/);
  refuses(['p', '--expect-uncovered', 's1'], /s1, which is not a shape/);
});

test('a shape named by both flags is refused rather than silently taking the last', () => {
  refuses(['p', '--expect-uncovered', 'S1', '--expect-served', 'S1'], /both served and uncovered/);
  // Named twice the same way is a duplicate, not a conflict.
  assert.equal(parse('p', '--expect-served', 'S1', '--expect-served', 'S1').expected.get('S1'), 'served');
});

test('a third positional is refused, and a missing project is refused', () => {
  refuses(['p', 'db', 'extra'], /unexpected argument extra/);
  refuses([], /a project is required/);
  refuses(['--expect-uncovered', 'S1'], /a project is required/);
});

test('whitespace around ids survives, and flags may precede the project', () => {
  const { positional, expected } = parse('--expect-uncovered', ' S1 , S3 ', 'p', 'db');
  assert.deepEqual(positional, ['p', 'db']);
  assert.deepEqual([...expected.keys()], ['S1', 'S3']);
});
