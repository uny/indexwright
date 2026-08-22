/**
 * Asking a real database what indexes it has (SPEC §3, *v0.3 — coverage check*).
 *
 * `readiness.ts` and `reconcile.ts` are the two questions `check` has to settle before it may report,
 * and both are deliberately I/O-free: they are fed a listing. This module is where the listing comes
 * from, and it is the only part of `check` that talks to Google. Keeping it this thin is what lets
 * the rules that decide whether a report goes out be tested without a network, a project, or a
 * three-and-a-half-minute index build.
 *
 * It performs one call — `projects.databases.collectionGroups.indexes.list` — and hands back what
 * came off the wire. It classifies nothing: an entry with a state this version cannot name, an
 * `apiScope` it does not compare under, a field it cannot read are all *conveyed*, because the
 * modules that own those questions answer them by declining, and a decline they never see is a
 * decline that does not happen.
 *
 * The one thing it does own is the difference between "listed, and empty" and "could not list".
 * `ReadinessGate.observe` reads `[]` as a database with nothing left to build, and SPEC §3 requires
 * that a principal which cannot list indexes be told readiness could not be established. A failure
 * therefore leaves here as an `AdminError` and never as an empty array.
 */

import { EMULATOR_REDIRECT, render } from './args.js';
import type { LiveCompositeIndex } from './reconcile.js';

export class AdminError extends Error {
  override readonly name = 'AdminError';
}

/**
 * The admin client's type, reached through `@google-cloud/firestore` rather than as its own
 * dependency.
 *
 * `Firestore.v1` is marked deprecated in 9.0.0, which moved these clients into
 * `@google-cloud/firestore-api` and left this accessor pointing at them. Declaring that package here
 * instead would be the un-deprecated path, and is not taken: `@google-cloud/firestore` depends on
 * `^0.2.0` of it while 0.5.0 is current, so a range of our own either duplicates the package in the
 * tree — two copies of the generated protos, and the replay client using the other one — or pins us
 * to whatever range the data client happens to carry, to be re-synchronised by hand at every bump.
 * Through the accessor there is one version by construction, and it is the one the replay client
 * uses. The cost is a rewrite of these few lines the day the accessor goes; that is cheaper than
 * either half of the alternative, and it is a compile error rather than a silent drift.
 *
 * The types describe the package as `export = FirebaseFirestore`, so `v1` sits directly on the
 * module type here. What the *runtime* hands back under ESM is a namespace whose `default` holds
 * those exports and whose `v1` is `undefined` — which is why `adminLister` unwraps and this does
 * not. Measured, not assumed: the two disagree, and following the types would be a `TypeError` no
 * compiler catches.
 */
type AdminNamespace = typeof import('@google-cloud/firestore');

/**
 * The slice of the admin client this module uses.
 *
 * Typed off the client itself, so a fake cannot drift from what the real one accepts, and so nothing
 * here has to model the request or the response shape a second time.
 */
export type IndexLister = Pick<
  InstanceType<AdminNamespace['v1']['FirestoreAdminClient']>,
  'listIndexesAsync'
>;

/**
 * The wildcard that lists every collection group's indexes in one call.
 *
 * `indexes.list` takes a collection group as its parent, and `check` has to see the whole set: the
 * corpus names the collection groups the *application* queries, and an index on a group nothing
 * queries is still part of the set `reconcile` compares. Enumerating groups first would also make
 * the listing a function of the corpus, so a set that diverges in a group the corpus does not
 * mention would reconcile as identical.
 */
const ALL_COLLECTION_GROUPS = '-';

/** The parent `indexes.list` is called with, built from the target the run announced. */
export function indexesParent(target: string): string {
  return `${target}/collectionGroups/${ALL_COLLECTION_GROUPS}`;
}

/**
 * A client for the named project.
 *
 * `projectId` is passed rather than left to be discovered, and that is the same requirement issue #8
 * settled on the command line rather than a second one: the client resolves an absent `projectId`
 * from `GOOGLE_CLOUD_PROJECT`, a `gcloud` default, or the credentials in use, and `check` may not let
 * ambient state decide which database is measured. The parent resource name carries the project
 * explicitly, so this changes no request; what it changes is that a target the operator did not name
 * cannot be reached through the client's own defaulting either.
 *
 * The emulator variable is refused here as well as in `parseCheck`. `parseCheck` is where an operator
 * gets the message, and this is what makes it a property of the module rather than of one caller —
 * the JavaScript API is public, and a caller reaching this directly with the variable exported would
 * otherwise get exactly the silent redirect issue #37 is about.
 */
export async function adminLister(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IndexLister> {
  const redirect = env[EMULATOR_REDIRECT];
  if (redirect !== undefined && redirect !== '') {
    throw new AdminError(
      `${EMULATOR_REDIRECT} is set to ${render(redirect)}; check reads a real database and cannot ` +
        'be pointed at an emulator',
    );
  }
  // Loaded here rather than at the top of the module, which is what makes this function async. The
  // client costs about 80ms to load against the 4ms the rest of this package does, and `index.ts`
  // is a single entry point — so an eager import would charge every caller of `parseCorpus` for a
  // Firestore SDK they never touch. Deferred, the cost lands on the one verb that needs it. The
  // refusal above stays in front of it deliberately: nothing is loaded, let alone constructed, on
  // the path where the client would have been silently redirected.
  const module = await import('@google-cloud/firestore');
  // `?? module` rather than `.default` outright: the fallback is what a version exporting `v1` as a
  // real named export would land on, and this way that is a no-op rather than a crash.
  const namespace = (module as { default?: AdminNamespace }).default ?? module;
  return new namespace.v1.FirestoreAdminClient({ projectId: project });
}

/**
 * Every composite index the target holds, or an `AdminError`.
 *
 * `target` is the `projects/{project}/databases/{database}` the run announced, not a project and a
 * database assembled again here. The string `check` echoes and the string it lists are then the same
 * string by construction, which is the one property the echo of issue #8 is worth anything for.
 *
 * Single-field indexes are not in the result and are not missing from it: they are a different
 * resource (`collectionGroups.fields`), and SPEC §5's canonical key describes composite indexes.
 *
 * The iteration is `listIndexesAsync`, which follows the page tokens itself. Doing that by hand is
 * where a partial listing comes from, and a partial listing is the worst answer this function could
 * return — indexes the target holds but this run did not see come back as `missing` from
 * `reconcile`, which reads as a divergence that is not there.
 */
export async function listLiveIndexes(
  target: string,
  lister: IndexLister,
): Promise<LiveCompositeIndex[]> {
  const parent = indexesParent(target);
  const indexes: LiveCompositeIndex[] = [];
  try {
    for await (const index of lister.listIndexesAsync({ parent })) {
      // Conveyed rather than converted, and the cast says so. The generated protos type every field
      // of an `Index` as optional, nullable, and — for the enums — possibly numeric, while
      // `LiveCompositeIndex` models the same message as the listings `reconcile` was written
      // against. Both consumers already read it that defensively: `readiness.ts` coerces `name` and
      // `state` before it touches them and classifies a state it cannot name as `unrecognised`, and
      // `readLive` refuses an entry whose scope, fields, or `apiScope` it cannot read. Coercing here
      // would move those decisions into the one module with no way to report them, and coercing
      // `null` is how a field with no path acquires one.
      indexes.push(index as unknown as LiveCompositeIndex);
    }
  } catch (error) {
    // Wrapped rather than propagated, because what the caller must not do with a failure is treat it
    // as a listing. A missing permission arrives here as well as a broken connection, and SPEC §3
    // asks that a principal which cannot list be told readiness could not be established.
    throw new AdminError(`could not list the indexes of ${parent}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return indexes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
