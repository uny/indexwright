/**
 * The corpus vocabulary of SPEC §7.
 *
 * Every list here is closed on purpose. A value the wire carries that none of them can name is
 * counted as a skip reason rather than written into the corpus under a name of this package's
 * invention, because a corpus is committed and read as evidence of what a suite exercised.
 */

/** The format version written into every corpus. Bumped only when an old reader would mis-read. */
export const CORPUS_VERSION = 2;

/**
 * The format versions this package can read. Writing is always `CORPUS_VERSION`.
 *
 * Two versions rather than one, and this is not the fallback SPEC §7 forbids. That rule is about an
 * *unknown* version: a reader handed one refuses rather than reading the members it recognises,
 * because the integer exists to announce exactly the change reading on would mis-read. Version 1 is
 * not unknown. Its shape is written down, and a reader that knows it reads it correctly and whole.
 *
 * The alternative was refusing every corpus committed before this release, which is the outcome the
 * bump was supposed to avoid — `producers` is optional by construction, so a version-1 corpus is a
 * corpus that names no producer, not one this reader has to guess at.
 *
 * Frozen, not merely `readonly`: the type is erased at runtime, and `parseCorpus` reads this array
 * to decide what it will accept, so a caller appending to the exported value would widen what this
 * package reads — a version whose members it has no code for — rather than break its own build.
 */
export const READABLE_CORPUS_VERSIONS: readonly number[] = Object.freeze([1, 2]);

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
  'aggregation-query',
  'listen-query',
  'partition-query',
  'undecodable-message',
  'unsupported-encoding',
  'unsupported-rpc',
  'unsupported-shape',
  'vector-query',
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

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
  readonly skipped: readonly SkipReason[];
}

/** A decoded query before normalisation: the tree as it arrived, with no key yet. */
export interface RawQuery {
  readonly collectionGroup: string;
  readonly queryScope: QueryScope;
  readonly where: FilterNode | null;
  readonly orderBy: readonly Order[];
}
