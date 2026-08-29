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
 *
 * What it does *not* own is the client's lifetime. See `IndexLister`.
 */

import { render } from './args.js';
import { loadFirestore, messageOf, redirectRefusal, type FirestoreModule } from './client.js';
import type { LiveCompositeIndex } from './reconcile.js';

export class AdminError extends Error {
  override readonly name = 'AdminError';
}

/**
 * The slice of the admin client this module uses, and the one method it does not.
 *
 * Typed off the client itself, so a fake cannot drift from what the real one accepts, and so nothing
 * here has to model the request or the response shape a second time.
 *
 * `close` is in the `Pick` without being called anywhere in this module, which is issue #39's
 * answer in one line. The gRPC stub is lazy — the constructor opens nothing and `close` is a no-op
 * until the first call creates it — so the channel appears on the first `listIndexesAsync` and then
 * refs the event loop until something closes it. A `check` that listed and reported would print its
 * report and never exit. Narrowed to `listIndexesAsync` alone, a caller holding an `IndexLister`
 * had no typed way to release it even if it wanted to, and the JavaScript API is public.
 *
 * Closing it *here* would be the smaller change and the wrong one: readiness is established by
 * observing the same set at least twice, separated by a settling period, so `listLiveIndexes` is
 * called repeatedly against one client and a lister that closed itself would build and tear down a
 * channel per poll. The lifetime is known by the caller that knows how many listings it will ask
 * for, so the affordance goes in the type and the decision stays with `check`.
 *
 * The client's `close()` is idempotent and safe on one that never opened a channel, so a caller may
 * close unconditionally in a `finally`.
 */
export type IndexLister = Pick<
  InstanceType<FirestoreModule['v1']['FirestoreAdminClient']>,
  'listIndexesAsync' | 'close'
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
 * The redirect variables are refused here as well as in `parseCheck`. `parseCheck` is where an
 * operator gets the message; this is what makes the refusal a property of the module rather than of
 * one caller, since the JavaScript API is public and a caller reaching this directly would otherwise
 * construct exactly the redirected client issue #37 is about. `replayClient` carries the same
 * refusal for the same reason — see `client.ts`.
 *
 * The caller owns what comes back and must close it. See `IndexLister`.
 */
export async function adminLister(project: string): Promise<IndexLister> {
  const refusal = redirectRefusal();
  if (refusal !== undefined) throw new AdminError(refusal);
  const namespace = await loadFirestore();
  // Checked rather than trusted, because `v1` is the one part of this that is not load-bearing for
  // the package that publishes it: it is `@internal` and `@deprecated`, installed with
  // `Object.defineProperty`, and so outside the semver promise `^9.0.0` buys. A consumer resolving a
  // later 9.x that dropped it would otherwise get `Cannot read properties of undefined` out of a
  // module whose stated contract is that its failures arrive as `AdminError` — a type nobody can
  // catch for, naming nothing anyone can act on.
  //
  // `Firestore` itself gets no such check in `replay.ts`, and the asymmetry is the point: that class
  // is the package's headline export and is inside the semver promise. This one is reached through
  // an accessor the package says is not for us.
  const admin = namespace.v1?.FirestoreAdminClient;
  if (admin === undefined) {
    throw new AdminError(
      "@google-cloud/firestore did not expose the admin client at `v1.FirestoreAdminClient`; the " +
        'installed version is likely newer than this package supports',
    );
  }
  return new admin({ projectId: project });
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
 *
 * The client is neither closed nor kept: this may be called many times against one lister, which is
 * what the readiness gate needs. See `IndexLister`.
 */
export async function listLiveIndexes(
  target: string,
  lister: IndexLister,
): Promise<LiveCompositeIndex[]> {
  const parent = indexesParent(target);
  const indexes: LiveCompositeIndex[] = [];
  try {
    // `autoPaginate: false` changes nothing about the paging and everything about the noise.
    // `asyncIterate` overwrites the setting with `false` unconditionally and then walks the page
    // tokens itself, one page at a time as the iterator is consumed — but the client's default call
    // settings carry `autoPaginate: true`, so leaving it unset makes gax print an
    // `AutopaginateTrueWarning` to stderr on every run. That line would land beside the one naming
    // the target, which is the one line `check` asks an operator to read.
    for await (const index of lister.listIndexesAsync({ parent }, { autoPaginate: false })) {
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
    // The message is rendered, not interpolated. Everything else written to this stream is — the
    // target, a refused segment, a redirect variable's value — and this is the one string on it that
    // the local machine did not author: it is whatever the service at the other end put in a gRPC
    // status. A `check` that has just been pointed somewhere unexpected is exactly when that matters,
    // since the reply is then chosen by whoever answered, and a status carrying a newline and
    // `indexwright-record: target …` would forge the one line an operator is asked to trust. `cause`
    // keeps the original for a caller that wants the status itself.
    throw new AdminError(`could not list the indexes of ${parent}: ${render(messageOf(error))}`, {
      cause: error,
    });
  }
  return indexes;
}
