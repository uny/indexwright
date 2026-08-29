/**
 * Executing a replay plan against the target, and reading what Firestore answers (SPEC §3, *v0.3 —
 * coverage check*; SPEC §7, *Replay without values*).
 *
 * `synthesise.ts` decides what a corpus entry has to be replayed *as* — which filters, which operand
 * shapes, which sort orders — and does it without a client, so the two mistakes that produce an
 * `INVALID_ARGUMENT` can be tested exhaustively. This module is the other half: it turns that plan
 * into a query object, runs it, and classifies the status. It invents no filters and drops none.
 *
 * The oracle is Firestore. Nothing here decides whether an index covers a query; it asks, and
 * reports which of three answers came back — served, `FAILED_PRECONDITION`, or something else.
 *
 * The values are synthesised and the claim they rest on is SPEC §7's: that index selection turns on
 * how a field is indexed rather than on the value compared against it. That claim is not published,
 * and it is the one assumption in v0.3 that a synthesised replay could get wrong.
 */

import { render } from './args.js';
import {
  FAILED_PRECONDITION,
  INVALID_ARGUMENT,
  loadFirestore,
  messageOf,
  redirectRefusal,
  type FirestoreModule,
} from './client.js';
import {
  isReplayComposite,
  NAME_FIELD,
  ReplayError,
  replayCollectionId,
  replaySegments,
  type ReplayLeaf,
  type ReplayNode,
  type ReplayPlan,
} from './synthesise.js';
import type { FilterOperator } from './types.js';

/** A replay target that could not be reached, or that this environment may not be pointed at. */
export class TargetError extends Error {
  override readonly name = 'TargetError';
}

export type ReplayStatus =
  /** The target answered. The candidate set covers this query. */
  | { readonly kind: 'served' }
  /** `FAILED_PRECONDITION`: the finding `check` exists to report. */
  | { readonly kind: 'uncovered'; readonly message: string }
  /**
   * `INVALID_ARGUMENT`: not a statement about the index set.
   *
   * SPEC §7 reports the latter and never the former. Either the synthesis is wrong or the query was
   * already invalid when it was captured — the corpus admits those, since it records what was sent
   * rather than what succeeded — and both are defects in the tooling or in the test that issued it.
   */
  | { readonly kind: 'invalid'; readonly message: string }
  /**
   * The plan could not be turned into a query at all. Not a status the target answered with.
   *
   * `planReplay` refuses every shape this version knows it cannot replay, so reaching here means the
   * refusal missed one — a field path, a collection id, or an operand table this module and
   * `synthesise.ts` disagree about. It is its own kind rather than `failed` or `invalid` for the
   * reason `buildReplayQuery` used to be built outside the `try`: it is a defect in this tool, and
   * reporting it as either of those would dress a tooling defect as a verdict about the index set.
   *
   * What it must not do is escape. An entry `check` is documented to *report* as unreplayable used
   * to leave as an uncaught rejection, taking the whole run — and every verdict it had already
   * reached — down with it, and exiting with the code that means "this query was not served".
   */
  | { readonly kind: 'unbuildable'; readonly message: string }
  /** Any other status. `check` could not answer for this entry, and says so rather than guessing. */
  | { readonly kind: 'failed'; readonly message: string };

/**
 * The client `check` replays through, reduced to what the verb does with it.
 *
 * Narrower than `IndexLister` is, and deliberately not typed off `Firestore`: what the verb needs is
 * "run this plan" and "let go of the channel", and the materialisation in between is this module's
 * business rather than something a caller should be able to substitute half of. `close` is here for
 * the reason it is on `IndexLister` — see issue #39 — and the data client refs the event loop the
 * same way the admin one does.
 */
export interface Replayer {
  run(plan: ReplayPlan): Promise<ReplayStatus>;
  close(): Promise<void>;
}

/**
 * The value a synthesised filter compares against, and the id of the document a `__name__` filter
 * names.
 *
 * One string for both, and it never has to exist: the target is queried, not written to, and a
 * reference operand is validated against the collection being queried rather than resolved.
 */
export const REPLAY_SENTINEL = '__indexwright_replay__';

const SDK_OPERATORS: Readonly<Record<FilterOperator, FirebaseFirestore.WhereFilterOp>> = {
  LESS_THAN: '<',
  LESS_THAN_OR_EQUAL: '<=',
  GREATER_THAN: '>',
  GREATER_THAN_OR_EQUAL: '>=',
  EQUAL: '==',
  NOT_EQUAL: '!=',
  ARRAY_CONTAINS: 'array-contains',
  IN: 'in',
  ARRAY_CONTAINS_ANY: 'array-contains-any',
  NOT_IN: 'not-in',
  // The unary operators have no spelling of their own in the SDK: they are an equality or an
  // inequality against `null` or `NaN`, which is what the client converts into a `unaryFilter` on
  // the wire. Going through the conversion rather than around it is what keeps the replayed query
  // the recorded one — the alternative is reaching for the client's internals.
  IS_NULL: '==',
  IS_NOT_NULL: '!=',
  IS_NAN: '==',
  IS_NOT_NAN: '!=',
};

const UNARY_VALUES: Partial<Record<FilterOperator, null | number>> = {
  IS_NULL: null,
  IS_NOT_NULL: null,
  IS_NAN: Number.NaN,
  IS_NOT_NAN: Number.NaN,
};

/**
 * A field path the SDK will build the same path from, or a `ReplayError`.
 *
 * The rule itself lives in `synthesise.ts` as `replaySegments`, and is applied during *planning* as
 * well as here. That is deliberate: a path this version cannot convert is a property of the string
 * the corpus recorded rather than of the client, so refusing it needs no client — and refusing it
 * during planning is what lets `check` report the entry alongside every other unreplayable one
 * instead of meeting it halfway through the replay loop. What is left here is the conversion.
 */
export function replayFieldPath(sdk: FirestoreModule, fieldPath: string): FirebaseFirestore.FieldPath {
  // `documentId()` rather than `new FieldPath('__name__')`: the SDK reserves the name and the
  // sentinel is the supported way to say it.
  if (fieldPath === NAME_FIELD) return sdk.FieldPath.documentId();
  return new sdk.FieldPath(...replaySegments(fieldPath));
}

function leafFilter(
  sdk: FirestoreModule,
  collection: FirebaseFirestore.CollectionReference,
  node: ReplayLeaf,
): FirebaseFirestore.Filter {
  const path = replayFieldPath(sdk, node.fieldPath);
  const op = SDK_OPERATORS[node.op];
  if (node.operand.arity === 'none') {
    // Indexed rather than defaulted: a unary operator this table failed to name would otherwise
    // compare against the sentinel string and replay a filter that was never sent.
    const value = UNARY_VALUES[node.op];
    if (value === undefined) throw new ReplayError(`no unary operand is defined for ${node.op}`);
    return sdk.Filter.where(path, op, value);
  }
  const value =
    node.operand.type === 'reference' ? collection.doc(REPLAY_SENTINEL) : REPLAY_SENTINEL;
  return sdk.Filter.where(path, op, node.operand.arity === 'array' ? [value] : value);
}

function nodeFilter(
  sdk: FirestoreModule,
  collection: FirebaseFirestore.CollectionReference,
  node: ReplayNode,
): FirebaseFirestore.Filter {
  if (!isReplayComposite(node)) return leafFilter(sdk, collection, node);
  const children = node.filters.map((child) => nodeFilter(sdk, collection, child));
  return node.op === 'AND' ? sdk.Filter.and(...children) : sdk.Filter.or(...children);
}

/**
 * The query one plan replays as.
 *
 * Separated from running it so that the materialisation can be tested against the SDK's own
 * `isEqual` without a database: constructing a `Firestore` opens no channel, so a test can build the
 * expected query by hand and compare. That is the only offline way to pin the mapping, and the
 * mapping is where a replayed query stops being the recorded one.
 *
 * Two things are deliberately absent. There is no `limit`: SPEC §7 records no limit, so adding one
 * is an unmeasured deviation, and if a limit did narrow index selection the cost would be a query
 * served that should have failed — a false clean verdict, which §2 forbids more strictly than a
 * false alarm. And there is no `select`: a projection can be served by a covering index the full
 * query would need more of, which is the same mistake in the other clothes.
 *
 * **What that costs is not bounded, and this version does not bound it.** The argument above is
 * about index selection only; it says nothing about how much comes back. The synthesised sentinel
 * matches nothing for an equality, but `!=`, `not-in`, and the negated unary operators match every
 * document that merely *has* the field — so an entry recorded from `status != x` replays as a read
 * of the whole collection, and `get()` buffers all of it. Against a throwaway target that is free;
 * against a populated one it is the whole collection billed and held in memory, per such entry, and
 * a `DEADLINE_EXCEEDED` from it classifies as `failed` and stops the run. Reading the status without
 * reading the result — a stream closed after the first document, which leaves the request on the
 * wire unchanged — would fix it, and is not attempted here because it is unmeasured against the
 * channel lifetime issue #39 is about.
 *
 * A `COLLECTION`-scope plan replays against the *root* collection of that id, because the corpus
 * records a collection id and never the parent path (SPEC §7). Index selection is by collection id
 * and scope, so the root collection asks the same question of the same index; what is lost is
 * nothing the corpus retained.
 */
export function buildReplayQuery(
  sdk: FirestoreModule,
  db: FirebaseFirestore.Firestore,
  plan: ReplayPlan,
): FirebaseFirestore.Query {
  // Re-checked rather than trusted, for the reason `adminLister` re-checks the redirect: a
  // `ReplayPlan` is a plain object and this function is exported, so a caller reaching it by another
  // route must not be able to hand `db.collection` a *path*. See `replayCollectionId`.
  const id = replayCollectionId(plan.collectionGroup);
  const collection = db.collection(id);
  let query: FirebaseFirestore.Query =
    plan.queryScope === 'COLLECTION_GROUP' ? db.collectionGroup(id) : collection;
  if (plan.where !== null) query = query.where(nodeFilter(sdk, collection, plan.where));
  for (const order of plan.orderBy) {
    query = query.orderBy(
      replayFieldPath(sdk, order.fieldPath),
      order.direction === 'DESCENDING' ? 'desc' : 'asc',
    );
  }
  return query;
}

/** Which of the three answers a rejection is. */
export function classifyRejection(error: unknown): ReplayStatus {
  // Read through a guard rather than a cast. `messageOf` is total on purpose, and a `.code` lookup
  // that threw would undo that from inside the one handler whose whole job is that any failure
  // leaves as a status — `Promise.reject()` with no argument is enough to reach it, and the entry's
  // verdict and the report around it would both be lost to a `TypeError` naming neither.
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  // Rendered for the reason `listLiveIndexes` renders: this is the one string on the stream that the
  // local machine did not author, and a status carrying a newline would forge a well-formed
  // `indexwright-record:` line beside the one an operator is asked to read.
  const message = render(messageOf(error));
  if (code === FAILED_PRECONDITION) return { kind: 'uncovered', message };
  if (code === INVALID_ARGUMENT) return { kind: 'invalid', message };
  return { kind: 'failed', message };
}

/**
 * A replayer for the named database.
 *
 * `projectId` and `databaseId` are both passed for the reason `adminLister` passes the project: a
 * target the operator did not name must not be reachable through the client's own defaulting either.
 *
 * The redirect refusal is repeated here rather than left to `parseCheck`, and it is not redundant:
 * `FIRESTORE_EMULATOR_HOST` redirects *this* client — the emulator enforces no composite index, so
 * every replayed query is served and the run reports full coverage having measured nothing. That is
 * the failure SPEC §3 names, and the guard belongs in the module that builds the client.
 *
 * The caller owns what comes back and must close it. A live gRPC channel refs the event loop.
 */
export async function replayClient(project: string, database: string): Promise<Replayer> {
  const refusal = redirectRefusal();
  if (refusal !== undefined) throw new TargetError(refusal);
  const sdk = await loadFirestore();
  const db = new sdk.Firestore({ projectId: project, databaseId: database });
  return {
    async run(plan: ReplayPlan): Promise<ReplayStatus> {
      // Materialisation is caught separately from the call, and kept separate from it. The concern
      // that once kept this outside a `try` — that a plan this version cannot build is a defect in
      // this tool rather than a status the target answered with, so swallowing it into a coverage
      // verdict would be a lie — is met by `unbuildable` being its own kind. Letting it throw met
      // that concern by losing the run instead.
      //
      // A `ReplayError` is this package's own sentence and already carries `render`ed parts, so
      // rendering it again would double-escape the one quoted path it names. Anything else out of
      // the SDK is a string this package did not author, and gets the treatment every such string
      // on this stream gets.
      let query: FirebaseFirestore.Query;
      try {
        query = buildReplayQuery(sdk, db, plan);
      } catch (error) {
        const message = error instanceof ReplayError ? error.message : render(messageOf(error));
        return { kind: 'unbuildable', message };
      }
      try {
        await query.get();
        return { kind: 'served' };
      } catch (error) {
        return classifyRejection(error);
      }
    },
    async close(): Promise<void> {
      await db.terminate();
    },
  };
}
