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

function pack(packageRoot, staging) {
  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', staging], { cwd: packageRoot }),
  );
  console.log(`packed ${packed[0].filename} (${packed[0].files.length} files)`);
  return {
    tarball: join(staging, packed[0].filename),
    files: new Set(packed[0].files.map((entry) => entry.path)),
  };
}

/**
 * @param {string} packageRoot directory holding the package.json to pack
 * @param {(context: {files: Set<string>, consumer: string, staging: string}) => void} body
 * @param {{alongside?: readonly string[]}} [options] package roots to pack and install with it,
 *   satisfying its runtime dependencies from this tree instead of from the registry
 */
export function withInstalledTarball(packageRoot, body, options = {}) {
  const staging = mkdtempSync(join(tmpdir(), 'indexwright-pack-'));
  try {
    console.log('packing…');
    const { tarball, files } = pack(packageRoot, staging);
    // A dependency inside this repository is installed from its own tarball rather than fetched.
    // Two reasons, and the first is what this whole script is for: the pair is released together, so
    // the version that matters is the one in the tree, not whichever one is already published. The
    // second is that fetching makes the check hostage to the installing environment — a registry
    // mirror that does not carry the package, or an `npm config set before` window that a
    // days-old release falls outside of, both fail it for reasons that have nothing to do with the
    // tarball.
    const dependencies = (options.alongside ?? []).map((root) => pack(root, staging).tarball);

    const consumer = join(staging, 'consumer');
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    );
    // --ignore-scripts for the same reason the release workflows carry it on their own `npm ci`:
    // verify-package runs inside those jobs, which hold `id-token: write`, so an install-time
    // script reached from here could mint the publishing credential from the job's OIDC identity
    // before the publish step runs. Nothing is fetched from the registry today — `alongside` above
    // is what keeps it that way — but this is the one install in the release that resolves against
    // a semver range with no lockfile, so it is the widest of them the day SPEC §3's Firestore
    // client lands. It costs the check nothing: neither package ships an install script, and
    // `checkDeclaredDependencies` is what holds the dependency set.
    console.log('installing the tarball…');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball, ...dependencies], {
      cwd: consumer,
    });

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

/**
 * A package's runtime dependencies are exactly the expected set.
 *
 * For a package that is allowed some, which is the weaker promise SPEC §3 makes about
 * `@indexwright/record`. Pinned as an exact set rather than a ceiling so that acquiring the next one
 * — §3 expects a Firestore client when replay arrives — is a deliberate edit here and not a thing
 * that lands in an adopter's tree unremarked.
 */
export function checkDeclaredDependencies(checker, manifest, expected) {
  checker.check(`declares exactly ${expected.join(', ') || 'no'} runtime dependencies`, () => {
    const declared = Object.keys(manifest.dependencies ?? {}).sort();
    const wanted = [...expected].sort();
    if (declared.length !== wanted.length || declared.some((name, i) => name !== wanted[i])) {
      throw new Error(`declares ${declared.join(', ') || '(none)'}`);
    }
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
