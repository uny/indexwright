/**
 * Deciding whether the single-field index configuration on the replay target is the one the
 * candidate declares (SPEC §3, *v0.3 — coverage check*; issue #53).
 *
 * `reconcile.ts` settles the composite half of the presence question against
 * `collectionGroups.indexes.list`. This module settles the other half against
 * `collectionGroups.fields.list`, and it exists because that half decides which replayed queries
 * succeed just as surely: a single-field query at `COLLECTION_GROUP` scope is served only by an
 * override declaring that scope, and an exemption (an override declaring no indexes) removes the
 * automatic single-field indexes, so queries that need no composite index at all begin answering
 * `FAILED_PRECONDITION`. Nothing in the indexes listing mentions either, so without this module both
 * failure modes §3 names arrive by a route `check` was not looking at — the quiet clean run and the
 * false gap alike.
 *
 * What is compared is the *declared* set, not the field space. Firestore indexes every field by
 * default and an override is a field that has stopped inheriting; `fields.list` is therefore asked,
 * under the same filter the Firebase CLI's `firestore:indexes` uses, for the fields carrying an
 * override or a TTL, which is the set a document's `fieldOverrides` corresponds to. The default
 * itself is in that listing too, as the field `__default__/*` — it is what the others stopped
 * inheriting from — and it is not an override: it is recognised by name and checked rather than
 * compared. Checked, because the linter's model of an override assumes the default is the three
 * indexes Firestore documents (`ASCENDING`, `DESCENDING`, `CONTAINS`, each at `COLLECTION` scope):
 * a database whose default differed would serve queries no declaration accounts for, and reporting
 * on it would be vouching for something this version has not modelled.
 *
 * `ttl` is carried on both sides and compared on neither. It decides when a document is deleted,
 * not which queries are served, and a run measuring coverage has no verdict to give about it.
 *
 * The rules are the composite module's, applied to a different resource: the same both-directions
 * comparison on the canonical key, the same `unreadable` refusal of a live entry the key cannot be
 * derived from, the same `incomparable` refusal of a declaration carrying what the key cannot see.
 * Where this module reads a nested index — each override's `indexConfig.indexes[]` is an `Index`
 * proto, the same message the composite listing yields — it holds it to the same `apiScope` and
 * `density` rules, with the same sets, imported rather than restated.
 *
 * Like `reconcile.ts` and `readiness.ts`, this module holds no client and performs no I/O.
 */

import {
  canonicalSingleFieldIndexes,
  fieldDirection,
  formatSingleFieldIndex,
  overrideKey,
  type AnalysedOverride,
  type CanonicalSingleFieldIndex,
  type IndexField,
  type SingleFieldIndex,
} from 'indexwright';
import type { LiveIndex } from './readiness.js';
import {
  COMPARABLE_API_SCOPES,
  COMPARABLE_DENSITIES,
  comparableAsDefault,
  comparableUnder,
  describeField,
  LOSSY_DIRECTIONS,
  type ReconciliationVerdict,
} from './reconcile.js';
import { compareByCodePoint } from './shape.js';

/**
 * One entry of a field's `indexConfig.indexes`, as `collectionGroups.fields.list` reports it.
 *
 * The same `Index` message the composite listing yields, so the same optional, nullable fields —
 * with `name` among them, since a nested index is reported without one. `fields` holds one element,
 * the field itself, and that element is where the direction lives: an `Index` has no direction of
 * its own. `state` is what `readiness.ts` reads, through `liveSingleFieldIndexes`.
 */
export interface LiveSingleFieldIndex {
  readonly name?: string | null;
  readonly state?: string | null;
  readonly queryScope?: string | null;
  readonly apiScope?: string | null;
  readonly density?: string | null;
  /**
   * The same `Index` proto `indexes.list` returns, so the same three fields SPEC §5's key cannot
   * see arrive here too — `test/fixtures/live-fields.json` shows the admin client filling them in on
   * every nested index — and are refused on the same terms. See `LiveCompositeIndex`.
   */
  readonly unique?: boolean | null;
  readonly multikey?: boolean | null;
  readonly shardCount?: number | null;
  readonly fields?: readonly IndexField[] | null;
}

/**
 * One field as `projects.databases.collectionGroups.fields.list` reports it.
 *
 * `indexConfig.indexes` is the whole configuration the field ends up with, not a delta — which is
 * what makes it comparable to a declared override, whose `indexes` is the whole configuration too.
 * An exempted field arrives with none. `usesAncestorConfig` says whether that configuration is the
 * field's own or inherited; see `readLiveField` for what this module does with it.
 */
export interface LiveField {
  readonly name: string;
  readonly indexConfig?: {
    readonly indexes?: readonly LiveSingleFieldIndex[] | null;
    readonly usesAncestorConfig?: boolean | null;
    readonly ancestorField?: string | null;
    readonly reverting?: boolean | null;
  } | null;
  /** Carried and not read. TTL is not a coverage question. */
  readonly ttlConfig?: { readonly state?: string | null } | null;
}

export const FIELD_UNREADABLE_REASONS = [
  /** The resource name did not have the shape the collection group and field path are read out of. */
  'name-unparseable',
  /**
   * The field inherits its configuration (`usesAncestorConfig`) and did not say what it inherited,
   * and its `ancestorField` is not an exemption in the same listing. The set is then whatever the
   * ancestor holds, which this entry does not tell. Also a field with no `indexConfig` at all, or
   * an `indexes` that is not an array: which of owning and inheriting it is cannot then be told.
   */
  'indexes-missing',
  'query-scope-missing',
  /**
   * A nested index did not carry exactly one field, or that field was not this one (a field with
   * no path included), or it carried none of `order`, `arrayConfig`, and `vectorConfig`.
   */
  'field-unreadable',
  /** An `apiScope` this version does not compare under. */
  'api-scope-unrecognised',
  /** A `density` this version does not compare under. */
  'density-unrecognised',
  /** `unique`, `multikey`, or `shardCount` set to something other than its default. Issue #30. */
  'unique-unrecognised',
  'multikey-unrecognised',
  'shard-count-unrecognised',
  /** `__default__/*` holds a set other than the three indexes every override is a departure from. */
  'default-changed',
  /**
   * `indexConfig.reverting`: the field is on its way back to its ancestor's configuration, and
   * whatever `indexes` it lists meanwhile is the transition, not a set.
   */
  'reverting',
] as const;

export type FieldUnreadableReason = (typeof FIELD_UNREADABLE_REASONS)[number];

/** Why a *declared* override could not be reconciled: the mirror of `FieldUnreadableReason`. */
export const OVERRIDE_INCOMPARABLE_REASONS = [
  'api-scope-unrecognised',
  'density-unrecognised',
  'unique-unrecognised',
  'multikey-unrecognised',
  'shard-count-unrecognised',
  /** A declared single-field index whose direction is one `LOSSY_DIRECTIONS` refuses. */
  'field-unreadable',
] as const;

export type OverrideIncomparableReason = (typeof OVERRIDE_INCOMPARABLE_REASONS)[number];

/** A declared override carrying something this version does not compare under. */
export interface IncomparableOverride {
  /** The canonical override key of SPEC §5, so a message names it the way the linter does. */
  readonly key: string;
  readonly declared: AnalysedOverride;
  readonly reason: OverrideIncomparableReason;
  /** What was actually declared, for a message. */
  readonly detail: string;
}

/**
 * A live field whose canonical form could not be derived. As with `UnreadableIndex`, a distinct
 * outcome from `extra`: one of these makes the whole reconciliation `indeterminate`.
 */
export interface UnreadableField {
  readonly name: string;
  readonly reason: FieldUnreadableReason;
  /** What was actually observed, for a message. Never a guess at the canonical form. */
  readonly detail: string;
}

export interface MatchedOverride {
  /** The canonical override key of SPEC §5, shared with the linter's output. */
  readonly key: string;
  readonly declared: AnalysedOverride;
  readonly live: LiveField;
}

/** A live override with no matching declaration. */
export interface ExtraOverride {
  readonly key: string;
  readonly live: LiveField;
}

/** The counterpart of `Reconciliation`, reaching the same three verdicts by the same rules. */
export interface OverrideReconciliation {
  readonly verdict: ReconciliationVerdict;
  /** Declared and present. Sorted by key. */
  readonly matched: readonly MatchedOverride[];
  /** Declared but absent from the target. Sorted by key. */
  readonly missing: readonly AnalysedOverride[];
  /** Present on the target but not declared. Sorted by key. */
  readonly extra: readonly ExtraOverride[];
  /** Sorted by name. */
  readonly unreadable: readonly UnreadableField[];
  /** Declarations this version cannot compare. Sorted by key. */
  readonly incomparable: readonly IncomparableOverride[];
}

/**
 * The field that stands for every field with no override.
 *
 * The listing calls it `__default__/*`, one field of a collection group that is not one; its
 * `indexConfig.indexes` is the configuration every other field inherits. The Firebase CLI drops it
 * from `firestore:indexes` output by this name, which is why a `firestore.indexes.json` never
 * declares it and why this module does not compare it.
 */
export const DEFAULT_COLLECTION_GROUP = '__default__';
export const DEFAULT_FIELD_PATH = '*';

/**
 * What `__default__/*` is expected to hold: ascending, descending, and array-contains, each at
 * collection scope. This is the set the documentation describes and the one the linter's
 * override model departs from; the identity is precomputed because the check is an equality.
 */
const DEFAULT_SET = identity(
  DEFAULT_COLLECTION_GROUP,
  DEFAULT_FIELD_PATH,
  canonicalSingleFieldIndexes([
    { queryScope: 'COLLECTION', order: 'ASCENDING' },
    { queryScope: 'COLLECTION', order: 'DESCENDING' },
    { queryScope: 'COLLECTION', arrayConfig: 'CONTAINS' },
  ]),
);

/**
 * The field path is the last segment and everything in it: a dotted path is one segment, and the
 * default's `*` is one segment. Nothing after `fields/` is a separator.
 */
const FIELD_NAME = /^projects\/[^/]+\/databases\/[^/]+\/collectionGroups\/([^/]+)\/fields\/(.+)$/;

/**
 * The comparison key. What the canonical override key of SPEC §5 renders, in a form whose
 * delimiters cannot collide with the values — see `identity` in `reconcile.ts`.
 */
function identity(
  collectionGroup: string,
  fieldPath: string,
  indexes: readonly CanonicalSingleFieldIndex[],
): string {
  return JSON.stringify([
    collectionGroup,
    fieldPath,
    indexes.map((index) => [index.queryScope, index.direction]),
  ]);
}

interface ReadableLiveField {
  readonly identity: string;
  readonly key: string;
  readonly live: LiveField;
}

/** The outcome for `__default__/*` holding what it should: neither compared nor refused. */
const DEFAULT_HELD = Symbol('default-held');

/**
 * Derive a live field's canonical form, or say why it could not be.
 *
 * The one reading this module makes that the composite side does not is of `usesAncestorConfig`.
 * An entry reaches this listing either because it carries its own configuration (the override the
 * declaration corresponds to) or because it carries a TTL and inherits the rest; the filter admits
 * both, as the Firebase CLI's does, so that a declaration with `ttl: true` and the default indexes
 * written out — which is how the CLI exports such a field — is matched rather than reported
 * `missing`. An inheriting field is expected to arrive with the inherited set materialised in
 * `indexConfig.indexes` — that is what the CLI's source reads from it — and is then read like any
 * other. One that does not is refused — with one exception: an absent set on a field that owns its
 * configuration is an exemption, and on a field that inherits it is an unknown *unless* the
 * `ancestorField` it names is itself an exemption in the same listing, in which case the inherited
 * set really is empty. That is the collection-level exemption Firestore documents (`<group>/*`
 * with no indexes) seen from a TTL field beneath it, and the CLI exports such a field as
 * `ttl: true, indexes: []`. A field with no `indexConfig` at all is refused too, since which of the
 * two it is cannot then be told, and reading it as an exemption would put it in `extra` — a
 * confident divergence about an entry nobody read. An inheriting field's materialised entries may
 * arrive naming the ancestor's `*` rather than the field; that spelling is accepted there, and
 * nowhere else.
 *
 * A field with `indexConfig.reverting` set is refused whatever else it carries: the API says it is
 * mid-transition back to its ancestor's configuration, so its `indexes` is not a set that will
 * hold. `liveSingleFieldIndexes` makes the readiness gate wait it out; this refusal is for the
 * confirmation after replay, which has no gate and must not vouch for a set that was moving.
 *
 * Everything in the paragraph above about an inheriting field is read from the Firebase CLI's
 * source and not yet from a listing: `test/fixtures/live-fields.json` carries no TTL field, because
 * TTL is billed and the disposable project is not (`observations.ttlNotObserved`). The two
 * expectations — that the set is materialised, and how its entries are spelled — are the first
 * things to check against a billed project, since a wrong one here declines every run against a
 * database with a TTL.
 *
 * What is not checked is that `__default__/*` is *present*. The filter admits it and every
 * observed listing carries it (`capture-live-fields.mjs` stops if one does not), but a listing
 * without it says nothing false about the overrides, so its absence is not a refusal.
 */
function readLiveField(
  live: LiveField,
  listing: ReadonlyMap<string, LiveField>,
): ReadableLiveField | UnreadableField | typeof DEFAULT_HELD {
  const name = String(live.name);
  const matched = FIELD_NAME.exec(name);
  const collectionGroup = matched?.[1];
  const fieldPath = matched?.[2];
  if (collectionGroup === undefined || fieldPath === undefined) {
    return { name, reason: 'name-unparseable', detail: name };
  }
  const config = live.indexConfig;
  if (config === undefined || config === null) {
    return { name, reason: 'indexes-missing', detail: String(config) };
  }
  if (config.reverting === true) {
    return { name, reason: 'reverting', detail: `ancestorField ${String(config.ancestorField)}` };
  }
  const inherits = config.usesAncestorConfig === true;
  let indexes: readonly LiveSingleFieldIndex[];
  if (config.indexes === undefined || config.indexes === null) {
    indexes = [];
  } else if (!Array.isArray(config.indexes)) {
    return { name, reason: 'indexes-missing', detail: String(config.indexes) };
  } else {
    indexes = config.indexes;
  }
  if (inherits && indexes.length === 0 && !inheritsAnExemption(config.ancestorField, listing)) {
    return {
      name,
      reason: 'indexes-missing',
      detail: `${String(config.indexes)} (ancestorField ${String(config.ancestorField)})`,
    };
  }
  const declared: SingleFieldIndex[] = [];
  for (const index of indexes) {
    if (index === null || index === undefined) {
      return { name, reason: 'field-unreadable', detail: describeField(index) };
    }
    if (!comparableUnder(index.apiScope, COMPARABLE_API_SCOPES)) {
      return { name, reason: 'api-scope-unrecognised', detail: String(index.apiScope) };
    }
    if (!comparableUnder(index.density, COMPARABLE_DENSITIES)) {
      return { name, reason: 'density-unrecognised', detail: String(index.density) };
    }
    if (!comparableAsDefault(index.unique, false)) {
      return { name, reason: 'unique-unrecognised', detail: String(index.unique) };
    }
    if (!comparableAsDefault(index.multikey, false)) {
      return { name, reason: 'multikey-unrecognised', detail: String(index.multikey) };
    }
    if (!comparableAsDefault(index.shardCount, 0)) {
      return { name, reason: 'shard-count-unrecognised', detail: String(index.shardCount) };
    }
    if (typeof index.queryScope !== 'string' || index.queryScope === '') {
      return { name, reason: 'query-scope-missing', detail: String(index.queryScope) };
    }
    // One field, and this one. A nested index naming another field, or two, is not something the
    // model has a place for, and keying it on the field it sits under would vouch for whatever it
    // actually indexes.
    if (!Array.isArray(index.fields) || index.fields.length !== 1) {
      return { name, reason: 'field-unreadable', detail: describeField(index.fields) };
    }
    const field = index.fields[0];
    if (field === null || field === undefined) {
      return { name, reason: 'field-unreadable', detail: describeField(field) };
    }
    // A field with no path is not read as this one: the composite side refuses the same shape, and
    // the alternative is keying on the field it sits under, which is the vouching the comment above
    // rules out.
    const ownPath =
      field.fieldPath === fieldPath || (inherits && field.fieldPath === DEFAULT_FIELD_PATH);
    if (!ownPath || LOSSY_DIRECTIONS.has(fieldDirection(field))) {
      return { name, reason: 'field-unreadable', detail: describeField(field) };
    }
    declared.push({
      queryScope: index.queryScope,
      ...(field.order === undefined ? {} : { order: field.order }),
      ...(field.arrayConfig === undefined ? {} : { arrayConfig: field.arrayConfig }),
      ...(field.vectorConfig === undefined ? {} : { vectorConfig: field.vectorConfig }),
    });
  }
  const canonical = canonicalSingleFieldIndexes(declared);
  const id = identity(collectionGroup, fieldPath, canonical);
  if (collectionGroup === DEFAULT_COLLECTION_GROUP && fieldPath === DEFAULT_FIELD_PATH) {
    if (id === DEFAULT_SET) return DEFAULT_HELD;
    return {
      name,
      reason: 'default-changed',
      detail: canonical.map(formatSingleFieldIndex).join('|'),
    };
  }
  return { identity: id, key: overrideKey(collectionGroup, fieldPath, canonical), live };
}

/**
 * Whether the named ancestor is, in this listing, an exemption: present, owning its configuration,
 * not reverting, and listing no indexes. Only then is an inheriting field's empty set known to be
 * empty rather than unreported. An ancestor that is absent — the filter admits every owning field,
 * so an exemption would be there — or is anything else leaves the set unknown.
 */
function inheritsAnExemption(
  ancestorField: string | null | undefined,
  listing: ReadonlyMap<string, LiveField>,
): boolean {
  if (typeof ancestorField !== 'string') return false;
  const ancestor = listing.get(ancestorField)?.indexConfig;
  if (ancestor === undefined || ancestor === null) return false;
  if (ancestor.usesAncestorConfig === true || ancestor.reverting === true) return false;
  const indexes = ancestor.indexes;
  return indexes === undefined || indexes === null || (Array.isArray(indexes) && indexes.length === 0);
}

/**
 * Why a declaration could not be reconciled, or `null` when it can be.
 *
 * The declared half of the guard `readLiveField` applies to the live side, for the same reason
 * `incomparableReason` exists in `reconcile.ts`: SPEC §4 keeps the keys it does not understand, so
 * a lint-clean override can ask for a density or an API scope the key cannot see, and matching it
 * on the key alone would vouch for a live index that differs in exactly that respect. Read from
 * `source.indexes` rather than the canonical set, which has already collapsed what it cannot see.
 */
function incomparableOverrideReason(
  declared: AnalysedOverride,
): { reason: OverrideIncomparableReason; detail: string } | null {
  for (const index of declared.source.indexes) {
    if (!comparableUnder(index['apiScope'], COMPARABLE_API_SCOPES)) {
      return { reason: 'api-scope-unrecognised', detail: String(index['apiScope']) };
    }
    if (!comparableUnder(index['density'], COMPARABLE_DENSITIES)) {
      return { reason: 'density-unrecognised', detail: String(index['density']) };
    }
    if (!comparableAsDefault(index['unique'], false)) {
      return { reason: 'unique-unrecognised', detail: String(index['unique']) };
    }
    if (!comparableAsDefault(index['multikey'], false)) {
      return { reason: 'multikey-unrecognised', detail: String(index['multikey']) };
    }
    if (!comparableAsDefault(index['shardCount'], 0)) {
      return { reason: 'shard-count-unrecognised', detail: String(index['shardCount']) };
    }
  }
  const lossy = declared.indexes.find((index) => LOSSY_DIRECTIONS.has(index.direction));
  if (lossy) {
    return { reason: 'field-unreadable', detail: formatSingleFieldIndex(lossy) };
  }
  return null;
}

function isUnreadableField(
  read: ReadableLiveField | UnreadableField | typeof DEFAULT_HELD,
): read is UnreadableField {
  return typeof read === 'object' && 'reason' in read;
}

/**
 * Compare the declared overrides with the live field listing, in both directions.
 *
 * The algorithm is `reconcile`'s: live entries bucketed by identity, declarations claiming a bucket
 * or landing in `missing`, unclaimed buckets landing in `extra`, and every list sorted so two runs
 * against the same target say the same thing in the same order. Two live fields sharing an identity
 * cannot happen — a field path names one resource — but the buckets are lists all the same, so a
 * listing that did repeat one would be reported twice rather than lose one.
 */
export function reconcileOverrides(
  candidate: readonly AnalysedOverride[],
  live: readonly LiveField[],
): OverrideReconciliation {
  const unreadable: UnreadableField[] = [];
  const byIdentity = new Map<string, ReadableLiveField[]>();
  // By resource name, for an inheriting field to find the ancestor it names. The first entry wins
  // a repeated name; a listing that repeats one is anomalous either way, and is reported as such.
  const byName = new Map<string, LiveField>();
  for (const entry of live) {
    const name = String(entry.name);
    if (!byName.has(name)) byName.set(name, entry);
  }
  for (const entry of live) {
    const read = readLiveField(entry, byName);
    if (read === DEFAULT_HELD) continue;
    if (isUnreadableField(read)) {
      unreadable.push(read);
      continue;
    }
    const bucket = byIdentity.get(read.identity);
    if (bucket) bucket.push(read);
    else byIdentity.set(read.identity, [read]);
  }

  const matched: MatchedOverride[] = [];
  const missing: AnalysedOverride[] = [];
  const incomparable: IncomparableOverride[] = [];
  const claimed = new Set<string>();
  for (const declared of candidate) {
    const key = identity(declared.collectionGroup, declared.fieldPath, declared.indexes);
    const refusal = incomparableOverrideReason(declared);
    if (refusal) {
      incomparable.push({ key: declared.key, declared, ...refusal });
      claimed.add(key);
      continue;
    }
    const bucket = byIdentity.get(key);
    const found = bucket?.[0];
    if (found === undefined) {
      missing.push(declared);
      continue;
    }
    claimed.add(key);
    matched.push({ key: declared.key, declared, live: found.live });
  }

  const extra: ExtraOverride[] = [];
  for (const [key, bucket] of byIdentity) {
    if (claimed.has(key)) continue;
    for (const entry of bucket) extra.push({ key: entry.key, live: entry.live });
  }

  matched.sort(
    (a, b) => compareByCodePoint(a.key, b.key) || a.declared.position - b.declared.position,
  );
  missing.sort((a, b) => compareByCodePoint(a.key, b.key) || a.position - b.position);
  extra.sort(
    (a, b) =>
      compareByCodePoint(a.key, b.key) ||
      compareByCodePoint(String(a.live.name), String(b.live.name)),
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

  const verdict: ReconciliationVerdict =
    unreadable.length > 0 || incomparable.length > 0
      ? 'indeterminate'
      : missing.length === 0 && extra.length === 0
        ? 'identical'
        : 'diverged';

  return { verdict, matched, missing, extra, unreadable, incomparable };
}

/**
 * The nested indexes of a field listing, as entries the readiness gate can observe.
 *
 * A single-field index builds like a composite one and reports the same `state` while it does, so
 * an override applied moments before a run is exactly the readiness window SPEC §3 guards against,
 * arriving by the other listing. The gate keys on names, and a nested index has none, so one is
 * made: the field's resource name and the index's scope and direction, which is stable across
 * polls, distinct within a field, and legible in a `waiting:` line. The direction is rendered even
 * when it could not be read — `UNKNOWN` — because this function's job is to name what is building,
 * and refusing what cannot be named is `reconcileOverrides`'s.
 *
 * Two entries stand for what a nested index cannot. A field listing no indexes is an exemption,
 * and an exemption has nothing to build — but it is part of the set, and the gate's fingerprint is
 * made of names, so one applied between two polls would otherwise leave the fingerprint unchanged
 * and the settling period unrestarted; `#exempt` gives it a name. A field whose `indexConfig` is
 * `reverting` is mid-transition whatever its `indexes` say, and `#reverting` is reported
 * `CREATING` so the gate waits for it as it waits for a building index; when the transition ends
 * the field leaves the listing (or stops reverting), the fingerprint moves, and settling restarts.
 */
export function liveSingleFieldIndexes(fields: readonly LiveField[]): LiveIndex[] {
  const flattened: LiveIndex[] = [];
  for (const field of fields) {
    const config = field.indexConfig;
    if (config === undefined || config === null) continue;
    if (config.reverting === true) {
      // The one entry, and not the nested ones beside it: they are the transition, not a set.
      flattened.push({ name: `${String(field.name)}#reverting`, state: 'CREATING' });
      continue;
    }
    const indexes = config.indexes;
    if (!Array.isArray(indexes) || indexes.length === 0) {
      if (indexes === undefined || indexes === null || Array.isArray(indexes)) {
        flattened.push({ name: `${String(field.name)}#exempt`, state: 'READY' });
      }
      continue;
    }
    for (const index of indexes) {
      const config = index?.fields?.[0];
      const direction = config === null || config === undefined ? 'UNKNOWN' : fieldDirection(config);
      flattened.push({
        name: `${String(field.name)}#${String(index?.queryScope)}:${direction}`,
        state: index?.state as string,
      });
    }
  }
  return flattened;
}
