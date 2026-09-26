/**
 * The corpus vocabulary of SPEC §7.
 *
 * Every list here is closed on purpose. A value the wire carries that none of them can name is
 * counted as a skip reason rather than written into the corpus under a name of this package's
 * invention, because a corpus is committed and read as evidence of what a suite exercised.
 */

/** The format version written into every corpus. Bumped only when an old reader would mis-read. */
export const CORPUS_VERSION = 3;

/**
 * The format versions this package can read. Writing is always `CORPUS_VERSION`.
 *
 * Three versions rather than one, and this is not the fallback SPEC §7 forbids. That rule is about
 * an *unknown* version: a reader handed one refuses rather than reading the members it recognises,
 * because the integer exists to announce exactly the change reading on would mis-read. Versions 1
 * and 2 are not unknown. Their shape is written down, and a reader that knows it reads it correctly
 * and whole.
 *
 * The alternative was refusing every corpus committed before this release, which is the outcome
 * each bump is supposed to avoid — `producers` and `aggregations` are both optional by construction,
 * so a version-1 corpus is a corpus that names no producer and no aggregation, not one this reader
 * has to guess at (issue #93: `aggregation-query` stays in the skip vocabulary as a legacy reason
 * for the same purpose, so a corpus that declined `RunAggregationQuery` under v0.2/v0.3 still reads).
 *
 * Frozen, not merely `readonly`: the type is erased at runtime, and `parseCorpus` reads this array
 * to decide what it will accept, so a caller appending to the exported value would widen what this
 * package reads — a version whose members it has no code for — rather than break its own build.
 */
export const READABLE_CORPUS_VERSIONS: readonly number[] = Object.freeze([1, 2, 3]);

/**
 * Who produced a corpus, and from what revision of their source (SPEC §7, *Producer identity*).
 *
 * Supplied by the caller, never discovered. A discovered identity is either a wall-clock timestamp,
 * which rewrites the file on every run and so defeats the diff stability §7 has the sort for, or it
 * is the machine — a hostname, a username, an absolute path — which is the same kind of leak into a
 * committed file that §7 refuses when it declines to interpolate wire-decoded text into `skipped`.
 */
export interface Producer {
  /** What produced the corpus: a suite, a package, a service. Never empty. */
  readonly name: string;
  /** The revision of that source, or `null` when the caller named none. */
  readonly revision: string | null;
}

/**
 * Why a query the proxy observed is not in the corpus (SPEC §7, *What is not captured*).
 *
 * Sorted, because a corpus writes this set in order and the source of truth for that order should
 * be one list rather than a sort call somewhere downstream.
 */
export const SKIP_REASONS = [
  'partition-query',
  'undecodable-message',
  'unsupported-encoding',
  'unsupported-rpc',
  'unsupported-shape',
  'vector-query',
] as const;

/**
 * Reasons a corpus may carry that no current recorder produces.
 *
 * `listen-query` was how record ≤ 0.7.0 counted a snapshot listener, before `Listen` was captured
 * (issue #6). `aggregation-query` was how every recorder through v0.3 counted a `RunAggregationQuery`
 * — SPEC §7 declined it outright, on the grounds that its index requirements are not the inner
 * query's — before issue #93 gave it a shape of its own (`AggregationShape`, below) with a key that
 * cannot collide with a plain entry's. A corpus committed under one of those releases still names one
 * of these two reasons, and a reader that refused the reason would refuse the file — the outcome §7's
 * "readable by anything that reads one" exists to rule out. Both are accepted on read, never written
 * by capture.
 */
export const LEGACY_SKIP_REASONS = ['aggregation-query', 'listen-query'] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];
export type LegacySkipReason = (typeof LEGACY_SKIP_REASONS)[number];

export type QueryScope = 'COLLECTION' | 'COLLECTION_GROUP';

export type Direction = 'ASCENDING' | 'DESCENDING';

export const FIELD_OPERATORS = [
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'EQUAL',
  'NOT_EQUAL',
  'ARRAY_CONTAINS',
  'IN',
  'ARRAY_CONTAINS_ANY',
  'NOT_IN',
] as const;

export const UNARY_OPERATORS = ['IS_NAN', 'IS_NULL', 'IS_NOT_NAN', 'IS_NOT_NULL'] as const;

export type FieldOperator = (typeof FIELD_OPERATORS)[number];
export type UnaryOperator = (typeof UNARY_OPERATORS)[number];
export type FilterOperator = FieldOperator | UnaryOperator;
export type CompositeOperator = 'AND' | 'OR';

/** A filter on one field. A unary filter reaches the corpus in the same shape, without a value. */
export interface FilterLeaf {
  readonly fieldPath: string;
  readonly op: FilterOperator;
}

export interface FilterComposite {
  readonly op: CompositeOperator;
  readonly filters: readonly FilterNode[];
}

export type FilterNode = FilterLeaf | FilterComposite;

export function isComposite(node: FilterNode): node is FilterComposite {
  return 'filters' in node;
}

export interface Order {
  readonly fieldPath: string;
  readonly direction: Direction;
}

/** One corpus entry: a query shape and the key it de-duplicates on. */
export interface QueryShape {
  readonly key: string;
  readonly collectionGroup: string;
  readonly queryScope: QueryScope;
  readonly where: FilterComposite;
  readonly orderBy: readonly Order[];
}

export interface Corpus {
  readonly corpusVersion: number;
  /**
   * The producers this corpus is the work of, sorted and de-duplicated, `[]` when none were named.
   *
   * A list rather than one producer, because §7's merge is a union and a merged corpus has to
   * record which part came from where. A single recorder writes one element.
   */
  readonly producers: readonly Producer[];
  readonly queries: readonly QueryShape[];
  /**
   * `RunAggregationQuery` entries (issue #93), present as a member only from `corpusVersion` 3 —
   * `[]` when a corpus named none, exactly as `producers` reads `[]` on a corpus below the version
   * that added it. Never merged with `queries`: the two arrays key into disjoint namespaces (see
   * `AggregationShape.key`), and a reader that had to tell them apart by shape rather than by which
   * array they arrived in would be reconstructing the very distinction the key is written to make.
   */
  readonly aggregations: readonly AggregationShape[];
  /** Sorted set. A legacy reason arrives only by reading a corpus an older release wrote. */
  readonly skipped: readonly (SkipReason | LegacySkipReason)[];
}

/** A decoded query before normalisation: the tree as it arrived, with no key yet. */
export interface RawQuery {
  readonly collectionGroup: string;
  readonly queryScope: QueryScope;
  readonly where: FilterNode | null;
  readonly orderBy: readonly Order[];
}

/**
 * The three aggregation functions `StructuredAggregationQuery.Aggregation` may name (issue #93).
 *
 * `find_nearest` has no aggregation counterpart in the published proto, so this list is not merely
 * what v0.4 recognises — it is the whole of what the wire can send. An `Aggregation` naming none of
 * these three is a message no SDK at the pinned `@google-cloud/firestore` version emits, and is
 * skipped as `unsupported-shape` rather than added here, on the same closed-vocabulary principle
 * `FIELD_OPERATORS` and `UNARY_OPERATORS` follow.
 */
export type AggregationOp = 'COUNT' | 'SUM' | 'AVG';

/**
 * One aggregation in a `StructuredAggregationQuery.aggregations` list, with everything SPEC §7
 * declines to record already gone: no `alias` (a client-chosen string, never index-relevant, and
 * never a source of wire text this package writes into the corpus of its own invention — see §6),
 * no `Count.up_to` (bounds the scan, does not change which index answers it — the same argument §7
 * makes for `limit`).
 */
export interface AggregationSpec {
  readonly op: AggregationOp;
  /** `null` for `COUNT`, which aggregates the whole matched document rather than one field. */
  readonly field: string | null;
}

/**
 * One `RunAggregationQuery` entry: the inner query shape `StructuredAggregationQuery.structured_query`
 * carries, plus the aggregation list, keyed so that it can never collide with a plain `QueryShape`
 * entry over the same inner query (see `aggregationKey` in `shape.ts`).
 *
 * The inner query's members are inlined rather than nesting a `QueryShape`, because a `QueryShape`
 * carries its own `key` — the canonical key of the *plain* query, which is not a component of this
 * entry's key and would invite reading it as though it were.
 */
export interface AggregationShape {
  readonly key: string;
  readonly collectionGroup: string;
  readonly queryScope: QueryScope;
  readonly where: FilterComposite;
  readonly orderBy: readonly Order[];
  /**
   * Sorted and de-duplicated — see `normaliseAggregations` in `shape.ts`. Firestore's index decision
   * does not depend on how many times a suite asked for the same aggregate, or on the order the
   * aggregations were listed in the request, so two requests differing only in either are one entry.
   */
  readonly aggregations: readonly AggregationSpec[];
}

/** A decoded aggregation query before normalisation, paired with its inner query. */
export interface RawAggregationQuery {
  readonly query: RawQuery;
  readonly aggregations: readonly AggregationSpec[];
}
