/**
 * The corpus vocabulary of SPEC §7.
 *
 * Every list here is closed on purpose. A value the wire carries that none of them can name is
 * counted as a skip reason rather than written into the corpus under a name of this package's
 * invention, because a corpus is committed and read as evidence of what a suite exercised.
 */

/** The format version written into every corpus. Bumped only when an old reader would mis-read. */
export const CORPUS_VERSION = 1;

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
