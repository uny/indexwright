import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findingsFor, lintFixtures } from './helpers.js';

function only(names, rule, options = {}) {
  return findingsFor(lintFixtures(names, { ...options, rules: [rule] }), rule);
}

test('R1 fires on a minority scope and names it', () => {
  const [finding, ...rest] = only(['scope-minority.json'], 'scope-mismatch');
  assert.equal(rest.length, 0, 'one finding per collectionGroup');
  assert.match(finding.message, /COLLECTION \(3\), COLLECTION_GROUP \(1\)/);
  assert.match(finding.message, /COLLECTION_GROUP is the minority/);
  assert.equal(finding.key, 'posts::COLLECTION_GROUP::pinned:ASCENDING|createdAt:DESCENDING');
  assert.deepEqual(finding.related, []);
});

test('R1 fires on an even split without naming a minority', () => {
  const [finding, ...rest] = only(['scope-even.json'], 'scope-mismatch');
  assert.equal(rest.length, 0);
  assert.match(finding.message, /COLLECTION \(2\), COLLECTION_GROUP \(2\)/);
  assert.match(finding.message, /No scope is in the minority/);
  // The lexicographically first scope supplies the keys, so the choice is not file-order dependent.
  assert.equal(finding.key, 'posts::COLLECTION::authorId:ASCENDING|createdAt:DESCENDING');
  assert.equal(finding.related.length, 1);
});

test('R1 stays quiet when each collectionGroup is internally consistent', () => {
  assert.deepEqual(only(['clean.json'], 'scope-mismatch'), []);
});

test('R2 groups every variant into one finding', () => {
  const [finding, ...rest] = only(['field-order-variant.json'], 'field-order-variant');
  assert.equal(rest.length, 0);
  assert.equal(finding.key, 'posts::COLLECTION::authorId:ASCENDING|status:ASCENDING');
  assert.deepEqual(finding.related, ['posts::COLLECTION::status:ASCENDING|authorId:ASCENDING']);
  assert.match(finding.message, /2 field orders/);
});

test('R2 ignores byte-identical declarations', () => {
  assert.deepEqual(only(['field-order-duplicate.json'], 'field-order-variant'), []);
});

test('R2 ignores indexes that differ in direction rather than order', () => {
  assert.deepEqual(only(['field-order-directions.json'], 'field-order-variant'), []);
});

test('R2 does not group two field sets that only collide once serialised', () => {
  // Directions are not checked against an enumeration (SPEC §4), so one may contain the
  // characters the key is built from; the grouping must still compare the fields themselves.
  assert.deepEqual(only(['field-order-separator.json'], 'field-order-variant'), []);
});

test('R2 sees through an explicitly written __name__', () => {
  const findings = only(['name-field-equivalence.json'], 'field-order-variant');
  assert.equal(findings.length, 1, 'the two spellings must land in the same group');
});

test('R3 fires on a trailing __name__ that restates the default', () => {
  const findings = only(['name-field-redundant.json'], 'explicit-name-field');
  assert.equal(findings.length, 2);
  assert.match(findings[0].message, /explicit __name__ \(ASCENDING\)/);
  assert.match(findings[1].message, /explicit __name__ \(DESCENDING\)/);
});

test('R3 stays quiet on a meaningful or non-trailing __name__', () => {
  assert.deepEqual(only(['name-field-meaningful.json'], 'explicit-name-field'), []);
});

test('R4 fires strictly above the threshold', () => {
  const options = { quota: 4, quotaThreshold: 0.5 };
  const [finding, ...rest] = only(['scope-minority.json'], 'quota-headroom', options);
  assert.equal(rest.length, 0);
  assert.equal(finding.key, null, 'the finding is about the file, not an index');
  assert.deepEqual(finding.related, []);
  assert.match(finding.message, /4 composite indexes declared, above 50% of the 4-index limit/);
  assert.match(finding.message, /the limit is exactly reached/);
});

test('R4 stays quiet at the threshold', () => {
  // 4 indexes against a limit of 8 at 0.5 is exactly the threshold, and the test is a strict >.
  assert.deepEqual(only(['scope-minority.json'], 'quota-headroom', { quota: 8, quotaThreshold: 0.5 }), []);
});

test('no rule fires on a clean file', () => {
  const result = lintFixtures(['clean.json']);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.warnings, 0);
});

test('unknown keys do not disturb the rules', () => {
  const result = lintFixtures(['unknown-keys.json']);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.errors, []);
});

test('an index that repeats a fieldPath is analysed rather than refused', () => {
  const result = lintFixtures(['repeated-field.json']);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.findings, []);
});

test('a vector index is keyed but not flagged', () => {
  const result = lintFixtures(['vector.json']);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.errors, []);
});

test('no message suggests that an index is unused or removable', () => {
  const result = lintFixtures([
    'scope-minority.json',
    'field-order-variant.json',
    'name-field-redundant.json',
  ]);
  assert.ok(result.findings.length > 0);
  for (const finding of result.findings) {
    assert.doesNotMatch(
      finding.message,
      /\bunused\b|\bnot used\b|safe to (delete|remove)|(delete|remove|drop) (the|this|one) index/i,
    );
  }
});
