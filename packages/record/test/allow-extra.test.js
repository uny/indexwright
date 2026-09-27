import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOW_EXTRA_VERSION, AllowExtraError, BASELINE_VERSION, parseAllowExtra } from '../dist/index.js';

const file = (value) => JSON.stringify(value);

const ONE = {
  allowExtraVersion: ALLOW_EXTRA_VERSION,
  allowed: [{ key: 'carts::COLLECTION::owner:ASCENDING', reason: 'kept alive for an unmerged branch, #140' }],
};

const refuses = (value, pattern) =>
  assert.throws(() => parseAllowExtra(typeof value === 'string' ? value : file(value)), (error) => {
    assert.ok(error instanceof AllowExtraError, `expected an AllowExtraError, got ${error}`);
    assert.match(error.message, pattern);
    return true;
  });

test('an allow-extra file reads back as the entries it names', () => {
  const allowExtra = parseAllowExtra(file(ONE));
  assert.equal(allowExtra.allowExtraVersion, ALLOW_EXTRA_VERSION);
  assert.deepEqual(allowExtra.allowed, ONE.allowed);
});

test('a baseline handed to --allow-extra by mistake is refused, not read as allowing nothing', () => {
  refuses(
    { baselineVersion: BASELINE_VERSION, accepted: [] },
    /allowExtraVersion .* is not readable by this version/,
  );
  refuses({ ...ONE, allowExtraVersion: ALLOW_EXTRA_VERSION + 1 }, /is not readable by this version/);
});

test('two entries for one key are refused rather than leaving the report to pick a reason', () => {
  refuses(
    { ...ONE, allowed: [{ key: 'k', reason: 'first' }, { key: 'k', reason: 'second' }] },
    /two entries share the key "k"/,
  );
});

test('a missing or unknown member is refused, on the file and on each entry', () => {
  refuses({ allowExtraVersion: ALLOW_EXTRA_VERSION }, /the allow-extra file is missing allowed/);
  refuses({ ...ONE, note: 'x' }, /the allow-extra file carries "note"/);
  refuses({ ...ONE, allowed: [{ reason: 'r' }] }, /allowed\[0\] is missing key/);
  refuses({ ...ONE, allowed: [{ key: 'k', reason: 'r', until: '2027' }] }, /allowed\[0\] carries "until"/);
});

test('an entry with an empty key or a whitespace reason is refused', () => {
  refuses({ ...ONE, allowed: [{ key: '', reason: 'r' }] }, /allowed\[0\]\.key is empty/);
  refuses({ ...ONE, allowed: [{ key: 'k', reason: ' \n\t' }] }, /allowed\[0\]\.reason is empty/);
});

test('text that is not JSON is refused as such', () => {
  refuses('{', /not valid JSON/);
});
