import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatGithub, formatJson, formatText } from '../dist/index.js';
import { lintFixtures } from './helpers.js';

const withFindings = () =>
  lintFixtures(['scope-minority.json', 'name-field-redundant.json', 'malformed-json.json']);

test('text output groups findings by rule and states the disclaimer', () => {
  const output = formatText(withFindings());
  assert.match(output, /^scope-mismatch {2}one collectionGroup/m);
  assert.match(output, /^explicit-name-field {2}/m);
  assert.ok(
    output.indexOf('scope-mismatch') < output.indexOf('explicit-name-field'),
    'rules appear in canonical order',
  );
  assert.match(output, /could not be analysed/);
  assert.match(output, /no finding indicates that an index is unused or safe to delete\./);
});

test('text output says so plainly when there is nothing to report', () => {
  const output = formatText(lintFixtures(['clean.json']));
  assert.match(output, /^No findings \(1 file, 4 rules\)\.$/m);
});

test('json output carries the specified shape', () => {
  const result = withFindings();
  const parsed = JSON.parse(formatJson(result));
  assert.deepEqual(Object.keys(parsed), ['version', 'files', 'summary', 'findings', 'errors']);
  assert.deepEqual(Object.keys(parsed.summary), ['warnings', 'errors', 'byRule']);
  assert.deepEqual(Object.keys(parsed.findings[0]), ['rule', 'file', 'key', 'message', 'related']);
  assert.deepEqual(Object.keys(parsed.errors[0]), ['file', 'message']);
  assert.equal(parsed.summary.warnings, parsed.findings.length);
  assert.equal(parsed.summary.errors, parsed.errors.length);
});

test('json output is byte-stable across runs', () => {
  assert.equal(formatJson(withFindings()), formatJson(withFindings()));
});

test('github output annotates findings as warnings and unusable files as errors', () => {
  const { commands, summary } = formatGithub(withFindings());
  assert.match(commands, /^::warning file=[^:]*::scope-mismatch: /m);
  assert.match(commands, /^::error file=/m);
  assert.match(summary, /^## indexwright$/m);
  assert.match(summary, /\| Rule \| File \| Index \| Detail \|/);
});

test('github output escapes the pipes inside canonical keys', () => {
  const { summary } = formatGithub(lintFixtures(['scope-minority.json']));
  const row = summary.split('\n').find((line) => line.includes('scope-mismatch') && line.startsWith('|'));
  assert.ok(row, 'a table row is present');
  assert.ok(row.includes('\\|'), 'the pipe inside the key is escaped');
  // Leading and trailing delimiters give two empty edges around the four cells.
  assert.equal(row.split(/(?<!\\)\|/).length, 6, 'the row still has four cells');
});

test('a linted file cannot forge lines in the text or github report', () => {
  // §4 accepts any string as a collectionGroup, so the value below reaches both renderers. Neither
  // may let it end the line it is printed on: the JSON contract keeps it verbatim, the reports
  // must keep it inside one line and one table row.
  const result = lintFixtures(['control-characters.json']);
  assert.match(result.findings[0].message, /## Forged heading/, 'the value does reach the message');

  for (const line of formatText(result).split('\n')) {
    assert.doesNotMatch(line, /^## Forged heading/, 'text output puts a finding on one line');
  }

  const { commands, summary } = formatGithub(result);
  for (const line of summary.split('\n')) {
    assert.doesNotMatch(line, /^## Forged heading/, 'the summary keeps the value inside its row');
  }
  const rows = summary.split('\n').filter((line) => line.startsWith('| `scope-mismatch`'));
  assert.equal(rows.length, 1, 'one finding is one row');
  assert.equal(rows[0].split(/(?<!\\)\|/).length, 6, 'the row still has four cells');
  assert.doesNotMatch(commands, /\n::/, 'no forged workflow command');
});

test('github output stays quiet when there is nothing to annotate', () => {
  const { commands, summary } = formatGithub(lintFixtures(['clean.json']));
  assert.equal(commands, '');
  assert.match(summary, /No findings across 1 file/);
});
