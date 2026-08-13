#!/usr/bin/env node
/**
 * Exercise what a consumer of `indexwright` gets: the bin, the documented `exports` entry, and the
 * type declarations.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkNoRuntimeDependencies,
  checkShippedFiles,
  createChecker,
  finish,
  run,
  withInstalledTarball,
} from './lib/tarball.mjs';

const root = fileURLToPath(new URL('../packages/indexwright/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const checker = createChecker();
const { check } = checker;

withInstalledTarball(root, ({ files, consumer }) => {
  checkShippedFiles(checker, files, [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
  ]);
  checkNoRuntimeDependencies(checker, manifest);

  // A check that the workspace does not leak into the tarball used to sit here. It was meaningful
  // while this package was packed from the repository root, where `packages/` was a sibling of
  // `dist/`. Packed from `packages/indexwright`, no path in the tarball can reach another package,
  // so the check asserted nothing — and a check that cannot fail reads as protection it is not
  // providing. `@indexwright/record` never had one, for the same reason.

  const bin = join(consumer, 'node_modules', '.bin', 'indexwright');

  check('the bin runs and reports a version', () => {
    const version = run(bin, ['--version']).trim();
    if (version !== manifest.version) throw new Error(`got ${version}, expected ${manifest.version}`);
  });

  check('the bin lints a file and honours --max-warnings', () => {
    const fixture = join(root, 'test', 'fixtures', 'scope-minority.json');
    // `root` is the package directory, so the fixture travels with the tests it belongs to.
    const clean = run(bin, ['lint', fixture, '--format', 'json']);
    if (JSON.parse(clean).summary.warnings < 1) throw new Error('expected at least one warning');
    try {
      run(bin, ['lint', fixture, '--max-warnings', '0'], { stdio: 'pipe' });
      throw new Error('expected exit code 1');
    } catch (error) {
      if (error.status !== 1) throw new Error(`expected exit code 1, got ${error.status}`);
    }
  });

  check('a verb that lives in the other package says where it went', () => {
    try {
      run(bin, ['record', '--', 'npm', 'test'], { stdio: 'pipe' });
      throw new Error('expected exit code 2');
    } catch (error) {
      if (error.status !== 2) throw new Error(`expected exit code 2, got ${error.status}`);
      if (!/@indexwright\/record/.test(String(error.stderr))) {
        throw new Error('the message does not name the package the verb ships in');
      }
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
});

finish(checker);
