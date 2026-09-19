#!/usr/bin/env node
/**
 * Regenerate `test/fixtures/live-indexes.json`: one composite index, as three tools report it, read
 * back from a real database.
 *
 * The fixture is the one primary source in this package for what the Admin API sends (issue #20).
 * Its worth is provenance, and provenance decays: the day the Admin API adds a field or renames an
 * enum, a listing nobody can re-observe is a hand-edited file with a date on it. Until this script
 * existed only the command that *created* the index was recorded, and none of the three read-backs
 * (issue #29). This is the sibling of `capture-fixtures.mjs`: run by hand, never in CI, and it
 * records what the tools returned without deciding what any of it means.
 *
 * What it does, in order, against the project it is given:
 *
 *   1. Lists every composite index through `v1.FirestoreAdminClient` — the same call, the same
 *      wildcard parent and the same `autoPaginate: false` as `admin.ts` — and creates, with `gcloud`,
 *      whichever of the three probe groups is missing. `probe` is created with no density and is
 *      the index the fixture pins; `probe_sparse_all` and `probe_density_unspecified` exist so that
 *      the `densityIsAlwaysStamped` and `wildcardListsEveryGroup` observations are read from a
 *      listing rather than remembered. Creation blocks until the index is built, which is minutes.
 *   2. Attempts the three creations the observations say a standard native database refuses —
 *      `--density sparse-any`, `--density dense`, `--unique` — and records each refusal verbatim.
 *      One of them succeeding is a finding, not a fixture: the script stops and says so.
 *   3. Reads the listing back four ways: the admin client over gRPC and again over `fallback: true`,
 *      `gcloud firestore indexes composite list --format=json`, and `firebase firestore:indexes`.
 *      The two client renderings must agree, which is what `enumsAreStrings` claims; if they do not
 *      the script stops with both, because the observation is then false and the note is wrong.
 *   4. Rewrites the fixture's `source` and the three renderings. `note` and `observations` are kept
 *      as they are: they are prose a maintainer wrote and this script has no opinion about them,
 *      the way `capture-fixtures.mjs` leaves the expected shapes to `test/decode.test.js`.
 *
 * The project id is replaced by the placeholder `demo-fixtures` throughout, as the fixture's note
 * says. Nothing in the tests reads the project segment.
 *
 * Nothing here deletes. The probe runbook (`probe/README.md`, step 1) wants a bare target, so after
 * a capture the groups this script created are the operator's to remove:
 *
 *     gcloud firestore indexes composite list --project <project> --database '(default)'
 *     gcloud firestore indexes composite delete <name> --project <project> --database '(default)'
 *
 * Requires application default credentials for the client, a `gcloud` login for `gcloud`, and a
 * `firebase login` for the Firebase CLI — three separate credentials, as the probe runbook explains.
 * `gcloud`'s configured default project is deliberately never used: every call names the project.
 *
 *     gcloud auth application-default login
 *     node packages/record/scripts/capture-live-indexes.mjs indexwright-probe '(default)'
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = 'demo-fixtures';
const PINNED_GROUP = 'probe';
/** Every group the capture lists, with the density flag its index is created under. */
const GROUPS = [
  [PINNED_GROUP, undefined],
  ['probe_sparse_all', 'sparse-all'],
  ['probe_density_unspecified', 'density-unspecified'],
];
/** The creations a standard native database refuses, each tried against a group that never exists. */
const REFUSALS = [
  ['sparseAny', ['--density', 'sparse-any']],
  ['dense', ['--density', 'dense']],
  ['unique', ['--unique']],
];
const REFUSED_GROUP = 'probe_refused';
const FIELDS = ['--field-config', 'field-path=x,order=ascending', '--field-config', 'field-path=z,order=ascending'];
const READY_TIMEOUT_MS = 15 * 60 * 1000;

function fail(message) {
  process.stderr.write(`capture-live-indexes: ${message}\n`);
  process.exit(2);
}

// The same refusals as `client.ts` and the probe scripts: a redirected environment would capture a
// listing from wherever the redirect points, and the fixture would say it came from Google.
for (const name of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN']) {
  if (process.env[name] !== undefined && process.env[name] !== '') fail(`refusing to run while ${name} is set`);
}

const [project, database = '(default)'] = process.argv.slice(2);
if (project === undefined) {
  fail("usage: node packages/record/scripts/capture-live-indexes.mjs <project> [database]");
}

const fixturePath = fileURLToPath(new URL('../test/fixtures/live-indexes.json', import.meta.url));
const existing = JSON.parse(readFileSync(fixturePath, 'utf8'));

/** Run a CLI to completion; the caller decides what a non-zero exit means. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  return result;
}
function must(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}:\n${result.stderr}`);
  return result.stdout;
}
const gcloud = (...args) => ['gcloud', [...args, '--project', project, '--database', database]];
const createIndex = (group, ...flags) =>
  gcloud('firestore', 'indexes', 'composite', 'create', '--collection-group', group, ...FIELDS, ...flags);
/** The command as an operator would type it, for the record. */
const shown = ([command, args]) => [command, ...args.map((a) => (/[\s()]/.test(a) ? `'${a}'` : a))].join(' ');

// --- the client, both ways ------------------------------------------------------------------

// `v1` is installed on the module with `defineProperty`, so it is not a named export the ESM
// loader can see; it has to be read off the unwrapped namespace, which is what `client.ts` does too.
const namespace = await import('@google-cloud/firestore').then((m) => m.default ?? m);
const FirestoreAdminClient = namespace.v1?.FirestoreAdminClient;
if (FirestoreAdminClient === undefined) fail('the installed @google-cloud/firestore has no v1.FirestoreAdminClient');

const parent = `projects/${project}/databases/${database}/collectionGroups/-`;
async function listWith(client) {
  const indexes = [];
  try {
    for await (const index of client.listIndexesAsync({ parent }, { autoPaginate: false })) {
      // Through JSON so the fixture holds what a consumer would serialise, not a proto instance.
      indexes.push(JSON.parse(JSON.stringify(index)));
    }
  } catch (error) {
    // Almost always credentials — expired ADC arrives as a 400 `invalid_rapt` wrapped in a retry
    // note — and a stack trace says less about that than the message does.
    fail(`could not list ${parent}: ${error.message}`);
  }
  return indexes.sort((a, b) => a.name.localeCompare(b.name));
}
const groupOf = (index) => index.name.split('/collectionGroups/')[1].split('/')[0];
const onlyIn = (indexes, group) => {
  const found = indexes.filter((index) => groupOf(index) === group);
  if (found.length !== 1) fail(`expected exactly one composite index in ${group}, found ${found.length}`);
  return found[0];
};

const grpc = new FirestoreAdminClient({ projectId: project });
const rest = new FirestoreAdminClient({ projectId: project, fallback: true });

try {
  // --- 1. the groups the observations are read from ----------------------------------------------
  let listing = await listWith(grpc);
  const created = [];
  for (const [group, density] of GROUPS) {
    if (listing.some((index) => groupOf(index) === group)) continue;
    const command = createIndex(group, ...(density === undefined ? [] : ['--density', density]));
    process.stderr.write(`creating ${group} (this blocks until the index is built)\n  ${shown(command)}\n`);
    must(...command);
    created.push(group);
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    listing = await listWith(grpc);
    const pending = GROUPS.map(([group]) => onlyIn(listing, group)).filter((index) => index.state !== 'READY');
    if (pending.length === 0) break;
    if (Date.now() > deadline) fail(`still not READY after ${READY_TIMEOUT_MS / 60000} minutes: ${pending.map((i) => i.name).join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  // --- 2. the creations that must fail --------------------------------------------------------------
  const refusals = {};
  for (const [key, flags] of REFUSALS) {
    const command = createIndex(REFUSED_GROUP, ...flags);
    const result = run(...command);
    if (result.status === 0) {
      fail(
        `${shown(command)} succeeded, which the fixture's observations say a standard native database refuses. ` +
          `Delete the index it built in ${REFUSED_GROUP} and reconsider the observations before capturing.`,
      );
    }
    refusals[key] = { command: shown(command), stderr: result.stderr.trim() };
  }

  // --- 3. the read-backs ----------------------------------------------------------------------------
  const viaRest = await listWith(rest);
  if (JSON.stringify(listing) !== JSON.stringify(viaRest)) {
    fail(
      'the admin client rendered the listing differently over gRPC and over `fallback: true`; ' +
        '`enumsAreStrings` no longer holds and the fixture cannot say it does.\n' +
        `gRPC:\n${JSON.stringify(listing, null, 2)}\nREST:\n${JSON.stringify(viaRest, null, 2)}`,
    );
  }

  const gcloudList = gcloud('firestore', 'indexes', 'composite', 'list', '--format=json');
  const byGcloud = JSON.parse(must(...gcloudList));

  // The Firebase CLI reads `.firebaserc` and drops `firebase-debug.log` in its cwd; neither belongs
  // in the repository, so it runs from a directory of its own.
  const firebaseList = ['firebase', ['firestore:indexes', '--project', project, '--database', database]];
  const byFirebase = JSON.parse(must(...firebaseList, { cwd: mkdtempSync(join(tmpdir(), 'capture-live-indexes-')) }));

  const describe = JSON.parse(must('gcloud', ['firestore', 'databases', 'describe', '--project', project, `--database=${database}`, '--format=json']));

  // --- 4. the fixture -------------------------------------------------------------------------------
  const versions = {
    '@google-cloud/firestore': createRequire(import.meta.url)('@google-cloud/firestore/package.json').version,
    gcloud: must('gcloud', ['version', '--format=value("Google Cloud SDK")']).trim(),
    firebase: must('firebase', ['--version']).trim(),
  };
  const withPlaceholder = (value) => JSON.parse(JSON.stringify(value).replaceAll(`projects/${project}/`, `projects/${PLACEHOLDER}/`));
  const today = new Date().toISOString().slice(0, 10);

  const source = {
    project: `${PLACEHOLDER} (placeholder; the observation was made against a disposable project)`,
    database,
    edition: `${describe.databaseEdition ?? 'unknown edition'}, ${describe.type ?? 'unknown type'} (from \`gcloud firestore databases describe\`)`,
    observed: today,
    script: 'packages/record/scripts/capture-live-indexes.mjs',
    versions,
    created: Object.fromEntries(
      GROUPS.map(([group, density]) => [group, shown(createIndex(group, ...(density === undefined ? [] : ['--density', density])))]),
    ),
    readBack: {
      liveByAdminClient:
        `v1.FirestoreAdminClient.listIndexesAsync({ parent: '${withPlaceholder(parent)}' }, { autoPaginate: false }), ` +
        'constructed with and without `fallback: true`; the two listings were compared equal',
      liveByGcloud: shown(gcloudList),
      declarationByFirebaseCli: shown(firebaseList),
    },
    refusals,
    wildcardListing: listing.map((index) => ({ collectionGroup: groupOf(index), density: index.density, state: index.state })),
  };

  const fixture = {
    note: existing.note,
    source,
    observations: existing.observations,
    liveByAdminClient: withPlaceholder(onlyIn(listing, PINNED_GROUP)),
    liveByGcloud: withPlaceholder(onlyIn(byGcloud, PINNED_GROUP)),
    declarationByFirebaseCli: (() => {
      const found = (byFirebase.indexes ?? []).filter((index) => index.collectionGroup === PINNED_GROUP);
      if (found.length !== 1) fail(`firebase firestore:indexes returned ${found.length} entries for ${PINNED_GROUP}`);
      return found[0];
    })(),
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stderr.write(
    `wrote ${fixturePath}\n` +
      (created.length === 0 ? '' : `created ${created.join(', ')}; the runbook wants them removed before a probe run\n`),
  );
} finally {
  await Promise.all([grpc.close(), rest.close()]);
}
