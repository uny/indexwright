#!/usr/bin/env node
/**
 * Regenerate `test/fixtures/live-fields.json`: the field overrides of a real database, as three
 * tools report them.
 *
 * The sibling of `capture-live-indexes.mjs`, for the other half of the index set (issue #53). The
 * composite fixture is the one primary source for what `indexes.list` sends; this one is the same
 * for `fields.list`, and `overrides.ts` rests on three claims about it that only a listing can
 * make: that the default is listed under `__default__/*` and holds the three documented indexes,
 * that an exempted field arrives with no `indexes`, and that a field carrying only a TTL arrives
 * with the set it inherits materialised — which is why the Firebase CLI's filter admits it and why
 * the declaration the CLI exports for it reconciles. Run by hand, never in CI; it records what the
 * tools returned and stops, rather than interpreting, when a return contradicts one of those.
 *
 * What it does, in order, against the project it is given:
 *
 *   1. Puts three fields of the collection group `probe_fields` into the three states an override
 *      can be in, each with the tool that can express it, and each only if the listing does not
 *      already show it: `tags` is given a `COLLECTION_GROUP` array index beside a `COLLECTION`
 *      ascending one through the admin client's `updateField` (the one writer here that can name a
 *      query scope — `gcloud`'s `--index` cannot); `body` is exempted with `gcloud firestore indexes
 *      fields update --disable-indexes`; `expiresAt` is made the group's TTL field with `gcloud
 *      firestore fields ttls update --enable-ttl` and is otherwise left inheriting. Then waits for
 *      every nested index to list as READY and the TTL as ACTIVE.
 *   2. Reads the listing back four ways: the admin client over gRPC and again over `fallback:
 *      true`, under the filter `admin.ts` sends; `gcloud firestore indexes fields list
 *      --format=json`; and `firebase firestore:indexes`, whose `fieldOverrides` is the declaration
 *      side. The two client renderings must agree.
 *   3. Rewrites the fixture's `source` and the three renderings. `note` and `observations` are kept
 *      as they are, for the same reason the composite script keeps them.
 *
 * The project id is replaced by the placeholder `demo-fixtures` throughout. Nothing here deletes;
 * the fields this script configures are the operator's to clear:
 *
 *     gcloud firestore indexes fields update tags --collection-group=probe_fields --clear-exemption --project <project>
 *     gcloud firestore indexes fields update body --collection-group=probe_fields --clear-exemption --project <project>
 *     gcloud firestore fields ttls update expiresAt --collection-group=probe_fields --disable-ttl --project <project>
 *
 * Requires application default credentials for the client, a `gcloud` login for `gcloud`, and a
 * `firebase login` for the Firebase CLI. `gcloud`'s configured default project is never used.
 *
 *     gcloud auth application-default login
 *     node packages/record/scripts/capture-live-fields.mjs indexwright-probe '(default)'
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = 'demo-fixtures';
const GROUP = 'probe_fields';
/** The filter `admin.ts` sends, restated here so the script does not import from `dist`. */
const FILTER = 'indexConfig.usesAncestorConfig=false OR ttlConfig:*';
const READY_TIMEOUT_MS = 15 * 60 * 1000;

function fail(message) {
  process.stderr.write(`capture-live-fields: ${message}\n`);
  process.exit(2);
}

for (const name of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN', 'CLOUDSDK_API_ENDPOINT_OVERRIDES_FIRESTORE']) {
  if (process.env[name] !== undefined && process.env[name] !== '') fail(`refusing to run while ${name} is set`);
}

const [project, database = '(default)'] = process.argv.slice(2);
if (project === undefined) {
  fail('usage: node packages/record/scripts/capture-live-fields.mjs <project> [database]');
}

const fixturePath = fileURLToPath(new URL('../test/fixtures/live-fields.json', import.meta.url));
const existing = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : {};

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
const shown = ([command, args]) => [command, ...args.map((a) => (/[\s()]/.test(a) ? `'${a}'` : a))].join(' ');

// --- the client, both ways ------------------------------------------------------------------

const namespace = await import('@google-cloud/firestore').then((m) => m.default ?? m);
const FirestoreAdminClient = namespace.v1?.FirestoreAdminClient;
if (FirestoreAdminClient === undefined) fail('the installed @google-cloud/firestore has no v1.FirestoreAdminClient');

const target = `projects/${project}/databases/${database}`;
const parent = `${target}/collectionGroups/-`;
const fieldName = (path) => `${target}/collectionGroups/${GROUP}/fields/${path}`;

async function listWith(client) {
  const fields = [];
  try {
    for await (const field of client.listFieldsAsync({ parent, filter: FILTER }, { autoPaginate: false })) {
      fields.push(JSON.parse(JSON.stringify(field)));
    }
  } catch (error) {
    fail(`could not list ${parent}: ${error.message}`);
  }
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}
const byName = (fields, name) => fields.find((field) => field.name === name);

const grpc = new FirestoreAdminClient({ projectId: project });
const rest = new FirestoreAdminClient({ projectId: project, fallback: true });

try {
  // --- 1. the three fields ----------------------------------------------------------------------
  let listing = await listWith(grpc);
  const provenance = {};

  // `tags`: the override with a scope, which only the API can express.
  const tagsRequest = {
    field: {
      name: fieldName('tags'),
      indexConfig: {
        indexes: [
          { queryScope: 'COLLECTION_GROUP', fields: [{ fieldPath: 'tags', arrayConfig: 'CONTAINS' }] },
          { queryScope: 'COLLECTION', fields: [{ fieldPath: 'tags', order: 'ASCENDING' }] },
        ],
      },
    },
    updateMask: { paths: ['index_config'] },
  };
  const tagsShown = `v1.FirestoreAdminClient.updateField(${JSON.stringify(tagsRequest)})`;
  if (byName(listing, fieldName('tags')) === undefined) {
    process.stderr.write(`configuring tags\n  ${tagsShown}\n`);
    // The mask is spelled two ways because the admin API has been seen to want either from a Node
    // client: canonical snake_case first, then the JSON name. Whichever it took is what is recorded.
    let sent = tagsRequest;
    try {
      await grpc.updateField(sent);
    } catch (first) {
      sent = { ...tagsRequest, updateMask: { paths: ['indexConfig'] } };
      try {
        await grpc.updateField(sent);
      } catch (second) {
        fail(`updateField on tags failed with both mask spellings:\n  index_config: ${first.message}\n  indexConfig: ${second.message}`);
      }
    }
    provenance.tags = `v1.FirestoreAdminClient.updateField(${JSON.stringify(sent)})`;
  } else {
    provenance.tags = `already listed before this run, not configured by it; assumed configured as: ${tagsShown}`;
  }

  // `body`: the exemption.
  const bodyCommand = gcloud('firestore', 'indexes', 'fields', 'update', 'body', `--collection-group=${GROUP}`, '--disable-indexes');
  if (byName(listing, fieldName('body')) === undefined) {
    const issued = [bodyCommand[0], [...bodyCommand[1], '--async']];
    process.stderr.write(`exempting body\n  ${shown(issued)}\n`);
    must(...issued);
    provenance.body = shown(issued);
  } else {
    provenance.body = `already listed before this run, not configured by it; assumed configured as: ${shown(bodyCommand)}`;
  }

  // `expiresAt`: TTL only, inheriting its indexes.
  const ttlCommand = gcloud('firestore', 'fields', 'ttls', 'update', 'expiresAt', `--collection-group=${GROUP}`, '--enable-ttl');
  if (byName(listing, fieldName('expiresAt')) === undefined) {
    const issued = [ttlCommand[0], [...ttlCommand[1], '--async']];
    process.stderr.write(`enabling TTL on expiresAt\n  ${shown(issued)}\n`);
    must(...issued);
    provenance.expiresAt = shown(issued);
  } else {
    provenance.expiresAt = `already listed before this run, not configured by it; assumed configured as: ${shown(ttlCommand)}`;
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    listing = await listWith(grpc);
    const pending = [];
    for (const path of ['tags', 'body', 'expiresAt']) {
      const field = byName(listing, fieldName(path));
      if (field === undefined) {
        pending.push(`${path} (not yet listed)`);
        continue;
      }
      for (const index of field.indexConfig?.indexes ?? []) {
        if (index.state !== 'READY' && index.state !== 'CREATING') fail(`${field.name} has an index in ${index.state}, which no amount of waiting turns READY`);
        if (index.state !== 'READY') pending.push(`${path} (${index.queryScope} index ${index.state})`);
      }
      if (path === 'expiresAt') {
        const state = field.ttlConfig?.state;
        if (state !== 'ACTIVE' && state !== 'CREATING') fail(`${field.name} TTL is ${state}, which no amount of waiting turns ACTIVE`);
        if (state !== 'ACTIVE') pending.push(`${path} (TTL ${state})`);
      }
    }
    if (pending.length === 0) break;
    if (Date.now() > deadline) fail(`still not ready after ${READY_TIMEOUT_MS / 60000} minutes: ${pending.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  // --- 2. the read-backs ----------------------------------------------------------------------------
  listing = await listWith(grpc);
  const viaRest = await listWith(rest);
  if (JSON.stringify(listing) !== JSON.stringify(viaRest)) {
    fail(
      'the admin client rendered the listing differently over gRPC and over `fallback: true`.\n' +
        `gRPC:\n${JSON.stringify(listing, null, 2)}\nREST:\n${JSON.stringify(viaRest, null, 2)}`,
    );
  }
  const theDefault = byName(listing, `${target}/collectionGroups/__default__/fields/*`);
  if (theDefault === undefined) fail('the filtered listing did not include __default__/*, which overrides.ts expects to find there');

  const gcloudList = gcloud('firestore', 'indexes', 'fields', 'list', '--format=json');
  const byGcloud = JSON.parse(must(...gcloudList));

  const firebaseList = ['firebase', ['firestore:indexes', '--project', project, '--database', database]];
  const byFirebase = JSON.parse(must(...firebaseList, { cwd: mkdtempSync(join(tmpdir(), 'capture-live-fields-')) }));

  const describe = JSON.parse(must('gcloud', ['firestore', 'databases', 'describe', '--project', project, `--database=${database}`, '--format=json']));

  // --- 3. the fixture -------------------------------------------------------------------------------
  const fromHere = createRequire(import.meta.url);
  const firestorePackage = fromHere.resolve('@google-cloud/firestore/package.json');
  const versions = {
    '@google-cloud/firestore': fromHere(firestorePackage).version,
    '@google-cloud/firestore-api': (() => {
      try {
        return createRequire(firestorePackage)('@google-cloud/firestore-api/package.json').version;
      } catch (error) {
        return fail(`could not resolve @google-cloud/firestore-api from ${firestorePackage}: ${error.message}`);
      }
    })(),
    gcloud: must('gcloud', ['version', '--format=value("Google Cloud SDK")']).trim(),
    firebase: must('firebase', ['--version']).trim(),
  };
  const withPlaceholder = (value) => {
    const text = JSON.stringify(value)
      .replaceAll(`projects/${project}/`, `projects/${PLACEHOLDER}/`)
      .replaceAll(`--project ${project} `, `--project ${PLACEHOLDER} `)
      .replaceAll(`--project ${project}"`, `--project ${PLACEHOLDER}"`);
    if (text.includes(project)) fail(`the project id survives outside a resource name or --project flag: ${text}`);
    return JSON.parse(text);
  };
  const today = new Date().toLocaleDateString('sv');

  const source = {
    project: `${PLACEHOLDER} (placeholder; the observation was made against a disposable project)`,
    database,
    edition: `${describe.databaseEdition ?? 'unknown edition'}, ${describe.type ?? 'unknown type'} (from \`gcloud firestore databases describe\`)`,
    observed: today,
    script: 'packages/record/scripts/capture-live-fields.mjs',
    versions,
    configured: provenance,
    readBack: {
      liveByAdminClient:
        `v1.FirestoreAdminClient.listFieldsAsync({ parent: '${withPlaceholder(parent)}', filter: '${FILTER}' }, { autoPaginate: false }), ` +
        'constructed with and without `fallback: true`; the two listings were compared equal',
      liveByGcloud: shown(gcloudList),
      declarationByFirebaseCli: shown(firebaseList),
    },
  };

  const fixture = {
    note:
      existing.note ??
      'The field overrides of one collection group, as three different tools report them, beside the database default. Verbatim except for the project id. Regenerate with `scripts/capture-live-fields.mjs`; `note` and `observations` are the parts it leaves to a maintainer.',
    source: withPlaceholder(source),
    observations: existing.observations ?? {},
    liveByAdminClient: withPlaceholder(listing),
    liveByGcloud: withPlaceholder(byGcloud),
    declarationByFirebaseCli: withPlaceholder(byFirebase.fieldOverrides ?? []),
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stderr.write(`wrote ${fixturePath}\n`);
} finally {
  await Promise.all([grpc.close(), rest.close()]);
}
