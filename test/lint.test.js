import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintTexts, RULE_IDS } from '../dist/index.js';
import { fixture, lintFixtures } from './helpers.js';

test('findings are sorted by file, then rule, then key', () => {
  const result = lintFixtures(['scope-minority.json', 'name-field-redundant.json']);
  const order = result.findings.map((finding) => [finding.file, finding.rule, finding.key ?? '']);
  const sorted = [...order].sort((a, b) => {
    const byFile = a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    if (byFile !== 0) return byFile;
    const byRule = RULE_IDS.indexOf(a[1]) - RULE_IDS.indexOf(b[1]);
    if (byRule !== 0) return byRule;
    return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
  });
  assert.deepEqual(order, sorted);
});

test('a file-wide finding sorts before the index findings of the same file', () => {
  const result = lintFixtures(['name-field-redundant.json'], { quota: 2, quotaThreshold: 0.5 });
  const quota = result.findings.filter((finding) => finding.key === null);
  assert.equal(quota.length, 1);
  assert.equal(result.findings.indexOf(quota[0]), result.findings.length - 1, 'quota-headroom is R4');
});

test('byRule lists every rule that ran, including the silent ones', () => {
  const result = lintFixtures(['clean.json']);
  assert.deepEqual(Object.keys(result.summary.byRule).sort(), [...RULE_IDS].sort());
  assert.deepEqual(Object.values(result.summary.byRule), [0, 0, 0, 0]);
});

test('byRule omits rules that did not run', () => {
  const result = lintFixtures(['clean.json'], { rules: ['scope-mismatch'] });
  assert.deepEqual(Object.keys(result.summary.byRule), ['scope-mismatch']);
});

test('rules run in canonical order whatever order they are requested in', () => {
  const result = lintFixtures(['clean.json'], {
    rules: ['quota-headroom', 'scope-mismatch'],
  });
  assert.deepEqual(Object.keys(result.summary.byRule), ['scope-mismatch', 'quota-headroom']);
});

test('rules are not applied across files', () => {
  // Each file alone is scope-consistent; together they would look like a mismatch.
  const result = lintTexts([
    {
      file: 'a.json',
      text: JSON.stringify({
        indexes: [
          {
            collectionGroup: 'posts',
            queryScope: 'COLLECTION',
            fields: [{ fieldPath: 'a', order: 'ASCENDING' }],
          },
        ],
      }),
    },
    {
      file: 'b.json',
      text: JSON.stringify({
        indexes: [
          {
            collectionGroup: 'posts',
            queryScope: 'COLLECTION_GROUP',
            fields: [{ fieldPath: 'a', order: 'ASCENDING' }],
          },
        ],
      }),
    },
  ]);
  assert.deepEqual(result.findings, []);
});

test('a malformed file becomes an error without stopping the others', () => {
  const result = lintFixtures(['malformed-json.json', 'scope-minority.json']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /invalid JSON/);
  assert.ok(
    result.findings.some((finding) => finding.file === fixture('scope-minority.json')),
    'the readable file is still linted',
  );
});

test('an unreadable file is reported like a malformed one', () => {
  const result = lintFixtures(['does-not-exist.json']);
  assert.deepEqual(result.errors.map((error) => error.message), ['no such file']);
  assert.equal(result.summary.errors, 1);
});

test('files lists every input, whether or not it parsed', () => {
  const result = lintFixtures(['malformed-json.json', 'clean.json']);
  assert.deepEqual(result.files, [fixture('clean.json'), fixture('malformed-json.json')]);
});

test('every result field is present on a clean run', () => {
  const result = lintFixtures(['clean.json']);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.errors, []);
  assert.equal(typeof result.version, 'string');
  assert.equal(result.summary.warnings, 0);
  assert.equal(result.summary.errors, 0);
});

test('related is always an array', () => {
  const result = lintFixtures(['scope-minority.json', 'name-field-redundant.json']);
  for (const finding of result.findings) {
    assert.ok(Array.isArray(finding.related));
  }
});
