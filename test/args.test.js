import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, UsageError } from '../dist/args.js';

function rejects(argv, fragment) {
  assert.throws(
    () => parseArgs(argv),
    (error) => {
      assert.ok(error instanceof UsageError, `expected UsageError, got ${error}`);
      assert.match(error.message, fragment);
      return true;
    },
  );
}

test('defaults match the specified CLI surface', () => {
  const command = parseArgs(['lint', 'a.json']);
  assert.equal(command.kind, 'lint');
  assert.deepEqual(command.files, ['a.json']);
  assert.equal(command.format, 'text');
  assert.equal(command.maxWarnings, Number.POSITIVE_INFINITY);
  assert.equal(command.quota, 1000);
  assert.equal(command.quotaThreshold, 0.8);
  assert.equal(command.rules.length, 4);
});

test('options accept both spellings', () => {
  const spaced = parseArgs(['lint', 'a.json', '--format', 'json', '--quota', '500']);
  const inline = parseArgs(['lint', 'a.json', '--format=json', '--quota=500']);
  assert.deepEqual(spaced, inline);
});

test('-- ends option parsing', () => {
  const command = parseArgs(['lint', '--', '--format']);
  assert.deepEqual(command.files, ['--format']);
});

test('repeated files are de-duplicated', () => {
  assert.deepEqual(parseArgs(['lint', 'a.json', 'a.json']).files, ['a.json']);
});

test('--rule selects and --disable subtracts, in canonical order', () => {
  assert.deepEqual(parseArgs(['lint', 'a.json', '--rule', 'quota-headroom', '--rule', 'scope-mismatch']).rules, [
    'scope-mismatch',
    'quota-headroom',
  ]);
  assert.deepEqual(parseArgs(['lint', 'a.json', '--disable', 'scope-mismatch']).rules, [
    'field-order-variant',
    'explicit-name-field',
    'quota-headroom',
  ]);
});

test('help and version win over everything else', () => {
  assert.equal(parseArgs(['lint', '--nope', '--help']).kind, 'help');
  assert.equal(parseArgs(['--version']).kind, 'version');
});

test('a typo in a rule id is a usage error, not a silently clean run', () => {
  rejects(['lint', 'a.json', '--rule', 'scope-mismatchh'], /unknown rule "scope-mismatchh"/);
  rejects(['lint', 'a.json', '--disable', 'nope'], /unknown rule "nope"/);
});

test('selecting and disabling everything is a usage error', () => {
  rejects(['lint', 'a.json', '--rule', 'scope-mismatch', '--disable', 'scope-mismatch'], /no rules to run/);
});

test('unusable invocations are rejected', () => {
  rejects([], /no command given/);
  rejects(['check', 'a.json'], /unknown command "check"/);
  rejects(['lint'], /no input files given/);
  rejects(['lint', 'a.json', '--nope'], /unknown option "--nope"/);
  rejects(['lint', 'a.json', '--format'], /--format needs a value/);
  rejects(['lint', 'a.json', '--format', 'yaml'], /unknown format "yaml"/);
});

test('numeric options are range-checked', () => {
  rejects(['lint', 'a.json', '--max-warnings', '-1'], /non-negative integer/);
  rejects(['lint', 'a.json', '--max-warnings', '1.5'], /non-negative integer/);
  rejects(['lint', 'a.json', '--quota', '0'], /positive integer/);
  rejects(['lint', 'a.json', '--quota-threshold', '0'], /\(0, 1\]/);
  rejects(['lint', 'a.json', '--quota-threshold', '1.5'], /\(0, 1\]/);
  assert.equal(parseArgs(['lint', 'a.json', '--quota-threshold', '1']).quotaThreshold, 1);
  assert.equal(parseArgs(['lint', 'a.json', '--max-warnings', '0']).maxWarnings, 0);
});
