import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('a clean file exits 0', () => {
  const result = run(['lint', fixture('clean.json')]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No findings/);
});

test('findings alone still exit 0', () => {
  const result = run(['lint', fixture('scope-minority.json')]);
  assert.equal(result.status, 0, 'the default policy must not gate a pipeline');
  assert.match(result.stdout, /scope-mismatch/);
});

test('--max-warnings turns findings into a failure', () => {
  assert.equal(run(['lint', fixture('scope-minority.json'), '--max-warnings', '0']).status, 1);
  assert.equal(run(['lint', fixture('scope-minority.json'), '--max-warnings', '1']).status, 0);
});

test('an unusable file exits 2 whatever --max-warnings says', () => {
  const result = run(['lint', fixture('malformed-json.json'), '--max-warnings', '100']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /invalid JSON/);
});

test('a usage error exits 2 and prints the usage on stderr', () => {
  const result = run(['lint', fixture('clean.json'), '--format', 'yaml']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown format "yaml"/);
  assert.match(result.stderr, /indexwright lint <file\.\.\.> \[options\]/);
});

test('--help and --version exit 0', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /No finding indicates that an index is unused or safe to delete\./);

  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
});

test('--format json writes only JSON to stdout', () => {
  const result = run(['lint', fixture('scope-minority.json'), '--format', 'json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.summary.warnings, parsed.findings.length);
});

test('--format github writes the summary to GITHUB_STEP_SUMMARY when it is set', () => {
  const directory = mkdtempSync(join(tmpdir(), 'indexwright-'));
  const summaryPath = join(directory, 'summary.md');
  try {
    const result = run(['lint', fixture('scope-minority.json'), '--format', 'github'], {
      GITHUB_STEP_SUMMARY: summaryPath,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^::warning file=/m);
    assert.doesNotMatch(result.stdout, /^## indexwright$/m, 'the summary went to the file');
    assert.match(readFileSync(summaryPath, 'utf8'), /^## indexwright$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--format github falls back to stdout without GITHUB_STEP_SUMMARY', () => {
  const result = run(['lint', fixture('scope-minority.json'), '--format', 'github']);
  assert.match(result.stdout, /^## indexwright$/m);
});

test('--rule narrows the run', () => {
  const result = run([
    'lint',
    fixture('name-field-redundant.json'),
    '--rule',
    'scope-mismatch',
    '--format',
    'json',
  ]);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed.summary.byRule), ['scope-mismatch']);
  assert.equal(parsed.findings.length, 0);
});

test('--quota and --quota-threshold drive R4', () => {
  const result = run([
    'lint',
    fixture('scope-minority.json'),
    '--quota',
    '4',
    '--quota-threshold',
    '0.5',
    '--rule',
    'quota-headroom',
    '--format',
    'json',
  ]);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].key, null);
});

test('output is identical across runs', () => {
  const args = ['lint', fixture('scope-minority.json'), fixture('name-field-redundant.json'), '--format', 'json'];
  assert.equal(run(args).stdout, run(args).stdout);
});
