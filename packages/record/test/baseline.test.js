import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE_VERSION, BaselineError, parseBaseline } from '../dist/index.js';

const file = (value) => JSON.stringify(value);

const ONE = {
  baselineVersion: BASELINE_VERSION,
  accepted: [{ key: 'orders::COLLECTION::AND(status:EQUAL)::', reason: 'legacy admin screen, tracked in #101' }],
};

const refuses = (value, pattern) =>
  assert.throws(() => parseBaseline(typeof value === 'string' ? value : file(value)), (error) => {
    assert.ok(error instanceof BaselineError, `expected a BaselineError, got ${error}`);
    assert.match(error.message, pattern);
    return true;
  });

test('a baseline reads back as the entries it names', () => {
  const baseline = parseBaseline(file(ONE));
  assert.equal(baseline.baselineVersion, BASELINE_VERSION);
  assert.deepEqual(baseline.accepted, ONE.accepted);
});

test('an entry with no reason is refused, because that is the whole of what stops a suppression list', () => {
  // There is no mechanical way to tell a justified entry from one added to make a build green. The
  // only thing this reader can insist on is that somebody wrote a sentence.
  refuses({ ...ONE, accepted: [{ key: 'k' }] }, /accepted\[0\] is missing reason/);
  refuses({ ...ONE, accepted: [{ key: 'k', reason: '' }] }, /accepted\[0\]\.reason is empty/);
  // Whitespace satisfies a length test and nothing else.
  refuses({ ...ONE, accepted: [{ key: 'k', reason: '  \n\t ' }] }, /cannot be told from one added to make a run pass/);
});

test('two entries for one key are refused rather than leaving the report to pick a reason', () => {
  refuses(
    { ...ONE, accepted: [{ key: 'k', reason: 'first' }, { key: 'k', reason: 'second' }] },
    /two entries share the key "k"/,
  );
});

test('order is not a refusal, unlike a corpus', () => {
  // A corpus is machine-written and its sort is what makes two recorders write the same bytes. A
  // baseline is written and re-written by hand; refusing it for the order somebody typed would be a
  // refusal about nothing.
  const unsorted = { ...ONE, accepted: [{ key: 'z', reason: 'r' }, { key: 'a', reason: 'r' }] };
  assert.deepEqual(parseBaseline(file(unsorted)).accepted.map((e) => e.key), ['z', 'a']);
});

test('the version is answered before the member set, so a future baseline says so', () => {
  // A bump is the normal reason a member appears. Testing membership first would answer a newer
  // file with a complaint about a stray field instead of the mismatch that explains it.
  refuses(
    { baselineVersion: BASELINE_VERSION + 1, accepted: [], somethingNew: true },
    /baselineVersion 2 is not readable by this version/,
  );
  refuses({ accepted: [] }, /baselineVersion undefined is not readable/);
});

test('a member this format does not define is refused rather than ignored', () => {
  // Ignoring it means reading a file written against a format this version cannot see, and
  // reporting that it read it.
  refuses({ ...ONE, extra: 1 }, /the baseline carries "extra"/);
  refuses(
    { ...ONE, accepted: [{ key: 'k', reason: 'r', expires: '2027-01-01' }] },
    /accepted\[0\] carries "expires"/,
  );
});

test('what is not a baseline is refused as one, and never repaired into one', () => {
  refuses('{', /not valid JSON/);
  refuses('[]', /the baseline is not an object/);
  refuses({ ...ONE, accepted: {} }, /accepted is not an array/);
  refuses({ ...ONE, accepted: ['k'] }, /accepted\[0\] is not an object/);
  refuses({ ...ONE, accepted: [{ key: 1, reason: 'r' }] }, /accepted\[0\]\.key is not a string/);
  refuses({ ...ONE, accepted: [{ key: 'k', reason: 2 }] }, /accepted\[0\]\.reason is not a string/);
  refuses({ ...ONE, accepted: [{ key: '', reason: 'r' }] }, /accepted\[0\]\.key is empty/);
});

test('a key this version could never have produced is carried rather than refused', () => {
  // It matches nothing, so it is reported as an entry that no longer reproduces — which is the
  // outcome, and a better one than refusing the whole file over an entry an older corpus left.
  const stale = { ...ONE, accepted: [{ key: 'not a §7 key at all', reason: 'left over' }] };
  assert.equal(parseBaseline(file(stale)).accepted.length, 1);
});

test('a composite version is named rather than serialised, so the refusal says what it is', () => {
  // The shallow case is what pins the rule: it names both composites, and it does so without
  // depending on the runtime's stack. Reverting the fix fails the deep case below as well — the
  // message is the serialised `[[[[` where the stack is big enough to build it, and `not valid
  // JSON` where `JSON.parse` refuses the depth — so that case is not vacuous either; what it cannot
  // say on its own is which composite got which name.
  refuses({ baselineVersion: [1], accepted: [] }, /baselineVersion \[\.\.\.\] is not readable/);
  refuses({ baselineVersion: { v: 1 }, accepted: [] }, /baselineVersion \{\.\.\.\} is not readable/);
});

test('a deeply nested version is a BaselineError, not a RangeError escaping the reader', () => {
  // Issue #60's own repro. `JSON.parse` and `JSON.stringify` do not have the same recursion budget,
  // and `stringify`'s frames are the heavier, so a value that parses can overflow on the way to
  // being refused — out of a function documented to fail one way.
  const deep = `${'['.repeat(10000)}${']'.repeat(10000)}`;
  refuses(`{"baselineVersion": ${deep}, "accepted": []}`, /baselineVersion \[\.\.\.\] is not readable/);
});

test('a primitive version is still quoted as itself, so the refusal names the value in the file', () => {
  refuses({ baselineVersion: '1', accepted: [] }, /baselineVersion "1" is not readable/);
  refuses({ baselineVersion: null, accepted: [] }, /baselineVersion null is not readable/);
});
