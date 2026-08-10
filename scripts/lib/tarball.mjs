/**
 * Pack a package, install it into a throwaway directory, and hand a consumer's view of it to a
 * caller's checks.
 *
 * A version published to npm cannot be replaced, so a missing file or a lost shebang has to be
 * caught here rather than by the first adopter. Shared by the two packages so that neither can
 * quietly get a weaker check than the other.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

export function createChecker() {
  let failures = 0;
  return {
    check(description, assertion) {
      try {
        assertion();
        console.log(`  ok  ${description}`);
      } catch (error) {
        failures += 1;
        console.error(`  FAIL ${description}\n       ${error.message}`);
      }
    },
    get failures() {
      return failures;
    },
  };
}

/**
 * @param {string} packageRoot directory holding the package.json to pack
 * @param {(context: {files: Set<string>, consumer: string, staging: string}) => void} body
 */
export function withInstalledTarball(packageRoot, body) {
  const staging = mkdtempSync(join(tmpdir(), 'indexwright-pack-'));
  try {
    console.log('packing…');
    const packed = JSON.parse(
      run('npm', ['pack', '--json', '--pack-destination', staging], { cwd: packageRoot }),
    );
    const tarball = join(staging, packed[0].filename);
    const files = new Set(packed[0].files.map((entry) => entry.path));
    console.log(`packed ${packed[0].filename} (${packed[0].files.length} files)`);

    const consumer = join(staging, 'consumer');
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    );
    console.log('installing the tarball…');
    run('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: consumer });

    body({ files, consumer, staging });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Every declared file is in the tarball, and no source map points at a file that is not. */
export function checkShippedFiles(checker, files, required) {
  for (const path of required) {
    checker.check(`ships ${path}`, () => {
      if (!files.has(path)) throw new Error('missing from the tarball');
    });
  }
  checker.check('ships no source maps of files it does not ship', () => {
    for (const path of files) {
      if (path.endsWith('.map') && !files.has(path.slice(0, -4))) {
        throw new Error(`${path} has no target`);
      }
    }
  });
}

/** A package that declares no runtime dependencies must not acquire one on install. */
export function checkNoRuntimeDependencies(checker, manifest) {
  checker.check('declares no runtime dependencies', () => {
    const declared = Object.keys(manifest.dependencies ?? {});
    if (declared.length > 0) throw new Error(`declares ${declared.join(', ')}`);
  });
}

export function finish(checker) {
  if (checker.failures > 0) {
    console.error(`\n${checker.failures} package check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\npackage checks passed');
  }
}
