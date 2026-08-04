#!/usr/bin/env node
/**
 * Pack the tarball, install it into a throwaway directory, and exercise what a consumer gets:
 * the `indexwright` bin, the documented `exports` entry, and the type declarations.
 *
 * A version published to npm cannot be replaced, so a missing file or a lost shebang has to be
 * caught here rather than by the first adopter.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const staging = mkdtempSync(join(tmpdir(), 'indexwright-pack-'));
let failures = 0;

function check(description, assertion) {
  try {
    assertion();
    console.log(`  ok  ${description}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${description}\n       ${error.message}`);
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

try {
  console.log('packing…');
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', staging], { cwd: root }));
  const tarball = join(staging, packed[0].filename);
  const files = new Set(packed[0].files.map((entry) => entry.path));

  console.log(`packed ${packed[0].filename} (${packed[0].files.length} files)`);
  for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts']) {
    check(`ships ${required}`, () => {
      if (!files.has(required)) throw new Error('missing from the tarball');
    });
  }
  check('ships no source maps of files it does not ship', () => {
    for (const path of files) {
      if (path.endsWith('.map') && !files.has(path.slice(0, -4))) {
        throw new Error(`${path} has no target`);
      }
    }
  });

  const consumer = join(staging, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  console.log('installing the tarball…');
  run('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: consumer });

  check('the bin runs and reports a version', () => {
    const version = run(join(consumer, 'node_modules', '.bin', 'indexwright'), ['--version']).trim();
    const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    if (version !== expected) throw new Error(`got ${version}, expected ${expected}`);
  });

  check('the bin lints a file and honours --max-warnings', () => {
    const fixture = join(root, 'test', 'fixtures', 'scope-minority.json');
    const bin = join(consumer, 'node_modules', '.bin', 'indexwright');
    const clean = run(bin, ['lint', fixture, '--format', 'json']);
    if (JSON.parse(clean).summary.warnings < 1) throw new Error('expected at least one warning');
    try {
      run(bin, ['lint', fixture, '--max-warnings', '0'], { stdio: 'pipe' });
      throw new Error('expected exit code 1');
    } catch (error) {
      if (error.status !== 1) throw new Error(`expected exit code 1, got ${error.status}`);
    }
  });

  check('the documented exports entry resolves', () => {
    const probe = join(consumer, 'probe.mjs');
    writeFileSync(
      probe,
      "import { lintTexts, rules } from 'indexwright';\n" +
        "const result = lintTexts([{ file: 'x.json', text: '{\"indexes\":[]}' }]);\n" +
        'if (rules.length !== 4) throw new Error("expected four rules");\n' +
        'if (result.summary.warnings !== 0) throw new Error("expected a clean result");\n' +
        'console.log("api ok");\n',
    );
    run(process.execPath, [probe], { cwd: consumer });
  });

  check('undeclared subpaths stay closed', () => {
    const probe = join(consumer, 'probe-subpath.mjs');
    writeFileSync(probe, "await import('indexwright/dist/lint.js');\n");
    try {
      run(process.execPath, [probe], { cwd: consumer, stdio: 'pipe' });
      throw new Error('an undeclared subpath resolved; the exports map is wider than intended');
    } catch (error) {
      if (!/ERR_PACKAGE_PATH_NOT_EXPORTED/.test(String(error.stderr ?? error.message))) throw error;
    }
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} package check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\npackage checks passed');
}
