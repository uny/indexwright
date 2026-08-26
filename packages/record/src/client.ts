/**
 * What the two modules that construct a Firestore client share.
 *
 * `check` builds two of them — `v1.FirestoreAdminClient` to list the target's indexes, and
 * `Firestore` to replay the corpus against it — and three things have to be identical across both
 * or the guard they carry is only as good as its weaker half: how the SDK is reached, when a
 * redirected environment is refused, and how a rejection from the other end is rendered.
 *
 * Nothing here constructs anything. It is the shared floor under `admin.ts` and `replay.ts`, which
 * own their clients and their error types.
 */

import { redirectReason, render, setRedirect } from './args.js';

/**
 * The SDK's type, as the module system sees it.
 *
 * The types describe the package as `export = FirebaseFirestore`, so the classes sit directly on the
 * module type. What the *runtime* hands back under ESM is a namespace whose `default` holds those
 * exports — which is why `loadFirestore` unwraps and this does not. Measured, not assumed: the two
 * disagree, and following the types would be a `TypeError` no compiler catches.
 */
export type FirestoreModule = typeof import('@google-cloud/firestore');

/**
 * Load the SDK, deferred to the paths that need it.
 *
 * Loaded here rather than at the top of a module, which is what makes every caller async. The SDK
 * costs about 80ms to load against the 4ms the rest of this package does, and `index.ts` is a single
 * entry point — so an eager import would charge every caller of `parseCorpus` for a Firestore SDK
 * they never touch. Deferred, the cost lands on the one verb that needs it.
 *
 * Callers refuse a redirected environment *before* calling this, deliberately: nothing is loaded,
 * let alone constructed, on the path where the client would have been silently redirected.
 */
export async function loadFirestore(): Promise<FirestoreModule> {
  const module = await import('@google-cloud/firestore');
  // `?? module` rather than `.default` outright: the fallback is what a version exporting the
  // classes as real named exports would land on, and this way that is a no-op rather than a crash.
  return (module as { default?: FirestoreModule }).default ?? module;
}

/**
 * Why this environment may not have a client built in it, or `undefined`.
 *
 * Returned rather than thrown so that each caller raises its own error type — the modules here are
 * named for the client they build, and a caller catching one should not have to know that the
 * refusal was decided somewhere else.
 *
 * `process.env` is read here rather than an injected environment, and that is the correction rather
 * than the convention: the clients read `process.env` themselves, unconditionally, and a guard that
 * consults anything else can disagree with the thing it is guarding. With an `env` parameter,
 * `adminLister('acme-prod', {})` passed the refusal and built a client the ambient environment then
 * redirected — the guard's own hole, in the shape of the hole it exists to close. The one source the
 * clients read is the one source this reads. Tests set and restore `process.env` accordingly.
 */
export function redirectRefusal(): string | undefined {
  const variable = setRedirect(process.env);
  if (variable === undefined) return undefined;
  return (
    `${variable} is set to ${render(process.env[variable] as string)}; check reads the database ` +
    `it was given, and ${redirectReason(variable)}`
  );
}

/**
 * A rejection's message, for a rejection this process did not author.
 *
 * Total by construction, because it is called from the handlers whose whole purpose is that a
 * failure leaves as the module's own error type rather than as a listing or a verdict. A `messageOf`
 * that threw would replace that with a `TypeError` from inside the handler, naming nothing anyone
 * can act on.
 *
 * The result is `render`ed by its callers rather than here, so that the escaping decision stays
 * visible at the point where the string reaches an output stream.
 */
export function messageOf(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : error;
    return typeof message === 'string' ? message : String(message);
  } catch {
    // A rejection with no route to a primitive. `Object.create(null)` is the plain case — no
    // prototype, so no `toString` — and a throwing `Symbol.toPrimitive` is the general one.
    try {
      // Reads no user-defined `toString`, so it survives both cases above — but it is not itself
      // total, and the comment that said it was is the reason this nesting is here. It looks up
      // `Symbol.toStringTag`, which a getter or a Proxy trap throws from as readily as
      // `Symbol.toPrimitive` does, and a fallback that can fail is not a fallback. The literal is
      // the floor: it names the shape of the failure without reading anything to do it.
      return Object.prototype.toString.call(error);
    } catch {
      return '[unprintable rejection]';
    }
  }
}

/**
 * The gRPC status codes this package reasons about, by number.
 *
 * Stated in-tree rather than imported from a status-code package, for the reason SPEC §3 gives for
 * the enum table in `types.ts`: these are the wire numbers of a released API, which cannot be
 * renumbered, and the alternative is a dependency that exists to hold two integers.
 */
export const FAILED_PRECONDITION = 9;
export const INVALID_ARGUMENT = 3;
