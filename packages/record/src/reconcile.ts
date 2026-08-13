/**
 * Deciding whether the index set on the replay target is the candidate set (SPEC §3, *v0.3 —
 * coverage check*).
 *
 * `check` does not apply the candidate set; it is handed a database that already has it. That leaves
 * it with no way to know, from the applying, *which* set it is measuring — and the verdict is only
 * about the candidate file if the two agree. Both directions of disagreement corrupt the report, in
 * opposite ways:
 *
 * - The target holds an index the file does not declare. Queries the candidate set alone would fail
 *   are served, so the run comes back clean and the coverage gap never appears in the output. This
 *   is the quiet one, and it is the failure mode issue #8 is about: a report that looks like a pass.
 * - The file declares an index the target does not hold. The query fails, and `check` reports a gap
 *   that the file does not actually have — the false `FAILED_PRECONDITION` §2 forbids acting on,
 *   arriving by a different route than the readiness window `readiness.ts` guards.
 *
 * So this is the presence half of the two questions `check` must settle before reporting;
 * `readiness.ts` is the *state* half, and deliberately does not answer this one — a `LiveIndex`
 * there carries only a name and a state, because readiness needs no declarations and presence does.
 *
 * Like `readiness.ts`, this module holds no client and performs no I/O. It is fed an analysed
 * candidate document and an observed listing.
 */

import { canonicalFields, fieldDirection, indexKey, type AnalysedIndex, type CanonicalField, type IndexField } from 'indexwright';
import type { LiveIndex } from './readiness.js';
import { compareByCodePoint } from './shape.js';

/**
 * One index as `projects.databases.collectionGroups.indexes.list` reports it.
 *
 * Every field beyond `name` is optional and nullable, which is not defensive typing: the generated
 * admin protos type them that way, and proto3 JSON omits a field set to its default entirely. An
 * entry missing what the canonical form is built from cannot be reconciled, and this module reports
 * that rather than filling it in — see `UnreadableIndex`.
 *
 * `state` is inherited from `LiveIndex` and is not consulted here. Whether the set has finished
 * building is `readiness.ts`'s question; whether it is the right set is this one's. A listing feeds
 * both.
 */
export interface LiveCompositeIndex extends LiveIndex {
  /** `COLLECTION` or `COLLECTION_GROUP`, in the same vocabulary a declaration uses. */
  readonly queryScope?: string | null;
  /** `ANY_API` for a native-mode Firestore index. */
  readonly apiScope?: string | null;
  /**
   * Which documents the index covers — `SPARSE_ALL`, `SPARSE_ANY`, `DENSE`.
   *
   * Modelled but never compared, and therefore refused: see `COMPARABLE_DENSITIES`.
   */
  readonly density?: string | null;
  /**
   * The index's fields, including the trailing `__name__` a live index carries — which is exactly
   * why the comparison goes through the canonical form of SPEC §5 rather than field-list equality.
   */
  readonly fields?: readonly IndexField[] | null;
}

export const UNREADABLE_REASONS = [
  /** The resource name did not have the shape the collection group is read out of. */
  'name-unparseable',
  'query-scope-missing',
  'fields-missing',
  /** A field carried none of `order`, `arrayConfig`, or `vectorConfig`. */
  'field-unreadable',
  /** An `apiScope` this version does not compare under. */
  'api-scope-unrecognised',
  /** A `density` this version does not compare under. */
  'density-unrecognised',
] as const;

export type UnreadableReason = (typeof UNREADABLE_REASONS)[number];

/**
 * Why a *declaration* could not be reconciled.
 *
 * The mirror of `UnreadableReason`, and it exists because refusing only the live side would be
 * half a guard. §5's canonical key is built from the collection group, the query scope, and the
 * fields; a declaration that also sets `density` or a non-native `apiScope` is asking for an index
 * the key cannot describe, and matching it on the key alone vouches for a live index that differs
 * in exactly the respect the declaration went out of its way to state.
 */
export const INCOMPARABLE_REASONS = ['api-scope-unrecognised', 'density-unrecognised'] as const;

export type IncomparableReason = (typeof INCOMPARABLE_REASONS)[number];

/** A declaration carrying something this version does not compare under. */
export interface IncomparableIndex {
  /** The canonical index key of SPEC §5, so a message names it the way the linter does. */
  readonly key: string;
  readonly declared: AnalysedIndex;
  readonly reason: IncomparableReason;
  /** What was actually declared, for a message. */
  readonly detail: string;
}

/**
 * A live entry whose canonical form could not be derived.
 *
 * This is a distinct outcome from `extra` on purpose. An entry that cannot be read might be the
 * declared index or might not, and both of the cheap alternatives are worse than saying so: calling
 * it `extra` invents a divergence, and dropping it hides a real one. SPEC §3 requires `check` to
 * decline to report rather than vouch for a set it cannot vouch for, so an unreadable entry makes
 * the whole reconciliation `indeterminate`.
 */
export interface UnreadableIndex {
  readonly name: string;
  readonly reason: UnreadableReason;
  /** What was actually observed, for a message. Never a guess at the canonical form. */
  readonly detail: string;
}

export interface MatchedIndex {
  /** The canonical index key of SPEC §5, shared with the linter's output. */
  readonly key: string;
  readonly declared: AnalysedIndex;
  readonly live: LiveCompositeIndex;
}

/** A live index with no matching declaration. */
export interface ExtraIndex {
  readonly key: string;
  readonly live: LiveCompositeIndex;
}

export type ReconciliationVerdict =
  /** The two sets agree. Replay measures the candidate file. */
  | 'identical'
  /** They disagree. A report would be about neither set.  */
  | 'diverged'
  /** A live entry could not be read, or a declaration could not be compared. Agreement is unknown. */
  | 'indeterminate';

export interface Reconciliation {
  readonly verdict: ReconciliationVerdict;
  /** Declared and present. Sorted by key. */
  readonly matched: readonly MatchedIndex[];
  /** Declared but absent from the target. Sorted by key. */
  readonly missing: readonly AnalysedIndex[];
  /** Present on the target but not declared. Sorted by key. */
  readonly extra: readonly ExtraIndex[];
  /** Sorted by name. */
  readonly unreadable: readonly UnreadableIndex[];
  /** Declarations this version cannot compare. Sorted by key. */
  readonly incomparable: readonly IncomparableIndex[];
}

const RESOURCE_NAME =
  /^projects\/[^/]+\/databases\/[^/]+\/collectionGroups\/([^/]+)\/indexes\/[^/]+$/;

/**
 * The `apiScope` values this module is willing to compare under.
 *
 * An absent `apiScope` is native-mode Firestore: proto3 JSON omits the field when it holds the
 * default, and the default is `ANY_API`. A value outside this set is classified unreadable rather
 * than `extra` — a Datastore-mode index is not a divergence from a Firestore declaration, it is a
 * thing the canonical key of §5 says nothing about, and reporting it as extra would manufacture a
 * disagreement that stops a correct run.
 */
const COMPARABLE_API_SCOPES: ReadonlySet<string> = new Set(['ANY_API']);

/**
 * The `density` values this module is willing to compare under: only the unset one.
 *
 * `density` decides *which documents* an index covers — `SPARSE_ANY` indexes a document when any
 * indexed field is present, `DENSE` indexes every document — so two indexes agreeing on collection
 * group, query scope, and fields can still serve different queries. SPEC §5's key is built from
 * those three and says nothing about density, and SPEC §4's declaration shape passes `density`
 * through without analysing it, so this module has no interpretation of it to compare with.
 *
 * Rather than key on it (which would extend §5's notion of index identity) or ignore it (which
 * vouches for a `DENSE` live index against a `SPARSE_ANY` declaration), a set that uses it is
 * refused. That is the same call the module makes for a Datastore-mode `apiScope`, and the same one
 * SPEC §3 asks for: decline rather than vouch. If this turns out to fire on ordinary listings —
 * whether the Admin API returns a density for every index is not settled here — it fails loudly,
 * with a named reason, which is the failure this module is willing to have.
 */
const COMPARABLE_DENSITIES: ReadonlySet<string> = new Set(['DENSITY_UNSPECIFIED']);

/** Absent is always comparable: proto3 JSON omits a field holding its default. */
function comparableUnder(value: unknown, comparable: ReadonlySet<string>): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && comparable.has(value);
}

/**
 * The directions `fieldDirection` returns when it could not read a field, rather than as its value.
 *
 * Both are many-to-one, and that is what makes them unusable here in a way they are not inside the
 * linter: `UNKNOWN` stands for any field carrying none of the three configs, and `VECTOR(?)` for any
 * vector field whose `dimension` is not a number — `parse.ts` checks only that `vectorConfig` is an
 * object, so a quoted dimension reaches it from a declaration too. Keyed on, two different fields
 * would key alike and could match each other, so a declared 128-dimension vector index would be
 * vouched for by a live 4096-dimension one. They are refused rather than keyed on.
 */
const LOSSY_DIRECTIONS: ReadonlySet<string> = new Set(['UNKNOWN', 'VECTOR(?)']);

/**
 * The identity two sides are matched on.
 *
 * Not the §5 key, and the difference matters here in a way it does not inside the linter. The §5 key
 * joins its parts on `::`, `|`, and `:`, none of which a collection id or a field path is forbidden
 * to contain, so it is not injective. Within one document a collision merely merges two spellings of
 * what the linter then reports on. Across the two sides of a reconciliation it would match a
 * declaration against a *different* live index and call the set identical — the one outcome this
 * module exists to prevent. `JSON.stringify` over an array is injective without needing any
 * assumption about which characters occur, the same reasoning `readiness.ts`'s `fingerprint` records.
 *
 * The §5 key is still what gets *reported*, so a message here names an index the way the linter does.
 */
function identity(
  collectionGroup: string,
  queryScope: string,
  fields: readonly CanonicalField[],
): string {
  return JSON.stringify([
    collectionGroup,
    queryScope,
    fields.map((field) => [field.fieldPath, field.direction]),
  ]);
}

interface ReadableLive {
  readonly identity: string;
  readonly key: string;
  readonly live: LiveCompositeIndex;
}

/**
 * Reduce one live entry to a canonical form, or say why it could not be.
 *
 * The collection group is read out of the resource name because the Admin API does not return it as
 * a field — it exists only as the `collectionGroups/{id}` segment. The segment is not percent-decoded:
 * Firestore forbids `/` in a collection id, so splitting on the path separator is unambiguous, while
 * decoding a segment that was never encoded would corrupt any id containing a literal `%`.
 */
function readLive(live: LiveCompositeIndex): ReadableLive | UnreadableIndex {
  // Coerced for the reason `readiness.ts` records: `name` is declared `string` but arrives from a
  // service that can send `null`, and it is about to be matched against a regular expression.
  const name = String(live.name);

  // Only *absent* means native mode. Anything else this version cannot name is refused, rather than
  // falling through to the default the way a `typeof === 'string'` guard would: a value the module
  // cannot classify is the case where assuming `ANY_API` vouches for a Datastore-mode index as
  // though it were the declared Firestore one, which is a false `identical` rather than a missed
  // one. The admin protos type the field nullable and can send the enum as a number.
  if (!comparableUnder(live.apiScope, COMPARABLE_API_SCOPES)) {
    return { name, reason: 'api-scope-unrecognised', detail: String(live.apiScope) };
  }

  if (!comparableUnder(live.density, COMPARABLE_DENSITIES)) {
    return { name, reason: 'density-unrecognised', detail: String(live.density) };
  }

  const matched = RESOURCE_NAME.exec(name);
  const collectionGroup = matched?.[1];
  if (collectionGroup === undefined) {
    return { name, reason: 'name-unparseable', detail: name };
  }

  if (typeof live.queryScope !== 'string' || live.queryScope === '') {
    return { name, reason: 'query-scope-missing', detail: String(live.queryScope) };
  }

  if (!Array.isArray(live.fields)) {
    return { name, reason: 'fields-missing', detail: String(live.fields) };
  }

  for (const field of live.fields) {
    // Nullish first, because `fieldDirection` reads `.order` off its argument and would throw
    // rather than reach a fallback — and throwing is the one thing this module must not do, since
    // §3 asks `check` to decline on an entry it cannot read, not to die on it.
    if (field === null || field === undefined || LOSSY_DIRECTIONS.has(fieldDirection(field))) {
      return { name, reason: 'field-unreadable', detail: String(field?.fieldPath) };
    }
  }

  const { fields } = canonicalFields(live.fields);
  return {
    identity: identity(collectionGroup, live.queryScope, fields),
    key: indexKey(collectionGroup, live.queryScope, fields),
    live,
  };
}

/**
 * Whether a declaration sets something this version does not compare under, and which.
 *
 * The declared side of the same guard `readLive` applies to the live side. SPEC §4 passes `density`
 * through unanalysed and ignores unknown keys, so a declaration can carry either of these and still
 * be a valid, lint-clean document — which is exactly why reconciliation has to notice.
 */
function incomparableReason(
  declared: AnalysedIndex,
): { reason: IncomparableReason; detail: string } | null {
  const { source } = declared;
  if (!comparableUnder(source['apiScope'], COMPARABLE_API_SCOPES)) {
    return { reason: 'api-scope-unrecognised', detail: String(source['apiScope']) };
  }
  if (!comparableUnder(source['density'], COMPARABLE_DENSITIES)) {
    return { reason: 'density-unrecognised', detail: String(source['density']) };
  }
  return null;
}

function isUnreadable(read: ReadableLive | UnreadableIndex): read is UnreadableIndex {
  return 'reason' in read;
}

/**
 * Compare a candidate set against the set a database holds.
 *
 * `candidate` is the output of `indexwright`'s `analyse`, so the canonicalisation of SPEC §5 — the
 * trailing `__name__` and the direction it would have had — is applied identically to both sides.
 * That stripping is the whole reason the comparison is possible at all: a live index always carries
 * the document key, and a declaration usually does not.
 *
 * Duplicate declarations that canonicalise alike are not this function's problem — that is the
 * linter's `field-order-variant` — but they must not be *made* into one. They collapse onto the one
 * live index they name rather than producing a spurious `missing`.
 *
 * What it compares is exactly §5's key: collection group, query scope, fields. A set that turns on
 * anything else — `density`, a Datastore-mode `apiScope` — is refused on whichever side carries it,
 * rather than matched on the key and vouched for. See `COMPARABLE_DENSITIES`.
 *
 * `live` must be a listing that succeeded. An empty array here means "observed, and empty", exactly
 * as in `ReadinessGate.observe`; passing `[]` for a listing that failed or came back partial would
 * report every declaration `missing`, which reads as a confident divergence rather than as the
 * "readiness could not be established" §3 requires.
 */
export function reconcile(
  candidate: readonly AnalysedIndex[],
  live: readonly LiveCompositeIndex[],
): Reconciliation {
  const unreadable: UnreadableIndex[] = [];
  const byIdentity = new Map<string, ReadableLive[]>();

  for (const entry of live) {
    const read = readLive(entry);
    if (isUnreadable(read)) {
      unreadable.push(read);
      continue;
    }
    const bucket = byIdentity.get(read.identity);
    if (bucket) bucket.push(read);
    else byIdentity.set(read.identity, [read]);
  }

  const matched: MatchedIndex[] = [];
  const missing: AnalysedIndex[] = [];
  const incomparable: IncomparableIndex[] = [];
  const claimed = new Set<string>();

  for (const declared of candidate) {
    // The declaration is refused before it is matched, not after: a declaration carrying a
    // discriminator §5's key does not describe would otherwise be *matched* on the key alone, and a
    // match is the false vouch. `source` is the declaration as written, so this reads what the file
    // actually said rather than what canonicalisation kept.
    const refusal = incomparableReason(declared);
    if (refusal) {
      incomparable.push({ key: declared.key, declared, ...refusal });
      continue;
    }

    const key = identity(declared.collectionGroup, declared.queryScope, declared.fields);
    const bucket = byIdentity.get(key);
    const found = bucket?.[0];
    if (found === undefined) {
      missing.push(declared);
      continue;
    }
    claimed.add(key);
    matched.push({ key: declared.key, declared, live: found.live });
  }

  const extra: ExtraIndex[] = [];
  for (const [key, bucket] of byIdentity) {
    // A declared identity is satisfied by the whole bucket, not just the entry `matched` names. Two
    // live indexes cannot share a canonical form, so a second entry in a bucket is a listing
    // anomaly rather than a set the file failed to declare, and calling it `extra` would report a
    // divergence the file cannot fix.
    if (claimed.has(key)) continue;
    for (const entry of bucket) extra.push({ key: entry.key, live: entry.live });
  }

  // Sorted by the §5 key, so a report reads the way the linter's output does — but never by the key
  // *alone*. The key is the non-injective one `identity` exists to avoid relying on, and two entries
  // that collide under it would then be ordered by wherever the listing happened to put them, which
  // is exactly the dependence on listing order the sort is here to remove. Each falls back to
  // something that really is unique: a declaration's position in the document, a live index's
  // resource name.
  matched.sort((a, b) => compareByCodePoint(a.key, b.key) || a.declared.position - b.declared.position);
  missing.sort((a, b) => compareByCodePoint(a.key, b.key) || a.position - b.position);
  extra.sort(
    (a, b) => compareByCodePoint(a.key, b.key) || compareByCodePoint(String(a.live.name), String(b.live.name)),
  );
  unreadable.sort(
    (a, b) =>
      compareByCodePoint(a.name, b.name) ||
      compareByCodePoint(a.reason, b.reason) ||
      compareByCodePoint(a.detail, b.detail),
  );
  incomparable.sort(
    (a, b) => compareByCodePoint(a.key, b.key) || a.declared.position - b.declared.position,
  );

  // Precedence mirrors `readiness.ts`: what the caller should do next, not severity. `indeterminate`
  // wins because an entry this version cannot read — or a declaration it cannot compare — means it
  // may be misreading the input, which is a reason to distrust the classification of everything else
  // alongside it. An incomparable declaration counts for the same reason an unreadable live entry
  // does: it was never matched, so `missing` and `extra` are not a statement about it either way.
  const verdict: ReconciliationVerdict =
    unreadable.length > 0 || incomparable.length > 0
      ? 'indeterminate'
      : missing.length === 0 && extra.length === 0
        ? 'identical'
        : 'diverged';

  return { verdict, matched, missing, extra, unreadable, incomparable };
}

/**
 * Whether replay would measure the candidate set.
 *
 * The counterpart of `isReportable` for the presence half. `check` must decline to report on
 * anything else — including `indeterminate`, which is the case where declining is the entire point.
 */
export function isVouched(reconciliation: Reconciliation): boolean {
  return reconciliation.verdict === 'identical';
}
