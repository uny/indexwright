/**
 * Decode a Firestore `RunQueryRequest` into the shape SPEC §7 records.
 *
 * Field numbers are from the published `google.firestore.v1` definitions. Two of them are easy to
 * get wrong and worth naming: `CollectionSelector.collection_id` and `FieldReference.field_path`
 * are both field **2**, not 1. Reading them as 1 yields a tree with the right structure and no
 * names at all, which parses cleanly and is silently empty.
 */
import type {
  CompositeOperator,
  Direction,
  FieldOperator,
  FilterNode,
  Order,
  RawQuery,
  SkipReason,
  UnaryOperator,
} from './types.js';
import { enumeration, fields, text, WireError } from './wire.js';

export type DecodeResult = { readonly ok: true; readonly query: RawQuery } | { readonly ok: false; readonly reason: SkipReason };

/** `RunQueryRequest.structured_query`. */
const RUN_QUERY_STRUCTURED_QUERY = 2;

/** `StructuredQuery` field numbers. `select`, `limit`, `offset`, and the cursors are not read. */
const QUERY_FROM = 2;
const QUERY_WHERE = 3;
const QUERY_ORDER_BY = 4;
const QUERY_FIND_NEAREST = 9;

const SELECTOR_COLLECTION_ID = 2;
const SELECTOR_ALL_DESCENDANTS = 3;

const FILTER_COMPOSITE = 1;
const FILTER_FIELD = 2;
const FILTER_UNARY = 3;

const COMPOSITE_OP = 1;
const COMPOSITE_FILTERS = 2;

const FIELD_FILTER_FIELD = 1;
const FIELD_FILTER_OP = 2;

const UNARY_FILTER_OP = 1;
const UNARY_FILTER_FIELD = 2;

const FIELD_REFERENCE_PATH = 2;

const ORDER_FIELD = 1;
const ORDER_DIRECTION = 2;

const COMPOSITE_OPERATORS = new Map<number, CompositeOperator>([
  [1, 'AND'],
  [2, 'OR'],
]);

const FIELD_OPERATORS = new Map<number, FieldOperator>([
  [1, 'LESS_THAN'],
  [2, 'LESS_THAN_OR_EQUAL'],
  [3, 'GREATER_THAN'],
  [4, 'GREATER_THAN_OR_EQUAL'],
  [5, 'EQUAL'],
  [6, 'NOT_EQUAL'],
  [7, 'ARRAY_CONTAINS'],
  [8, 'IN'],
  [9, 'ARRAY_CONTAINS_ANY'],
  [10, 'NOT_IN'],
]);

const UNARY_OPERATORS = new Map<number, UnaryOperator>([
  [2, 'IS_NAN'],
  [3, 'IS_NULL'],
  [4, 'IS_NOT_NAN'],
  [5, 'IS_NOT_NULL'],
]);

/**
 * A value the vocabulary of SPEC §7 cannot name.
 *
 * Thrown rather than returned so that the decision to skip does not have to be threaded back up
 * through every level of a recursive filter tree, where one forgotten check would record a
 * partially understood query as a complete one.
 */
class UnsupportedShape extends Error {
  override readonly name = 'UnsupportedShape';
}

/** A `find_nearest` clause anywhere in the query; skipped as `vector-query`, not as a bad shape. */
class VectorQuery extends Error {
  override readonly name = 'VectorQuery';
}

/**
 * How deep a filter tree may nest before it is declined rather than descended into.
 *
 * The reader recurses once per level, so bytes off a socket choose the stack depth. A few hundred
 * levels is already far past anything a client composes; without a ceiling, a body well under
 * `MAX_REQUEST_BYTES` reaches `RangeError`, which is not a `WireError` and would leave the proxy
 * as an uncaught exception rather than a counted skip.
 */
const MAX_FILTER_DEPTH = 100;

export function decodeRunQuery(message: Uint8Array): DecodeResult {
  try {
    return { ok: true, query: readRunQueryRequest(message) };
  } catch (error) {
    if (error instanceof VectorQuery) return { ok: false, reason: 'vector-query' };
    if (error instanceof UnsupportedShape) return { ok: false, reason: 'unsupported-shape' };
    if (error instanceof WireError) return { ok: false, reason: 'undecodable-message' };
    throw error;
  }
}

function readRunQueryRequest(message: Uint8Array): RawQuery {
  let query: Uint8Array | null = null;
  for (const field of fields(message)) {
    if (field.number === RUN_QUERY_STRUCTURED_QUERY && field.kind === 'bytes') query = field.value;
  }
  if (query === null) throw new UnsupportedShape('request carries no structured query');
  return readStructuredQuery(query);
}

function readStructuredQuery(bytes: Uint8Array): RawQuery {
  const selectors: { collectionId: string | null; allDescendants: boolean }[] = [];
  const orderBy: Order[] = [];
  let where: FilterNode | null = null;

  for (const field of fields(bytes)) {
    switch (field.number) {
      case QUERY_FROM:
        if (field.kind === 'bytes') selectors.push(readCollectionSelector(field.value));
        break;
      case QUERY_WHERE:
        // `where` is singular; a repeated occurrence is protobuf's "last one wins".
        if (field.kind === 'bytes') where = readFilter(field.value, 1);
        break;
      case QUERY_ORDER_BY:
        if (field.kind === 'bytes') orderBy.push(readOrder(field.value));
        break;
      case QUERY_FIND_NEAREST:
        throw new VectorQuery('query carries a find_nearest clause');
      default:
        break;
    }
  }

  // SPEC §7: an entry holds exactly one collectionGroup, so a query that does not name exactly one
  // collection is skipped because the corpus cannot say what it means — not because it is unknown.
  const [selector] = selectors;
  if (selectors.length !== 1 || selector === undefined || selector.collectionId === null) {
    throw new UnsupportedShape('query does not name exactly one collection');
  }

  return {
    collectionGroup: selector.collectionId,
    queryScope: selector.allDescendants ? 'COLLECTION_GROUP' : 'COLLECTION',
    where,
    orderBy,
  };
}

function readCollectionSelector(bytes: Uint8Array): { collectionId: string | null; allDescendants: boolean } {
  let collectionId: string | null = null;
  let allDescendants = false;
  for (const field of fields(bytes)) {
    if (field.number === SELECTOR_COLLECTION_ID && field.kind === 'bytes') {
      const value = text(field.value);
      // An empty collection_id is how a `from` names no collection at all.
      collectionId = value.length > 0 ? value : null;
    } else if (field.number === SELECTOR_ALL_DESCENDANTS && field.kind === 'varint') {
      allDescendants = field.value !== 0n;
    }
  }
  return { collectionId, allDescendants };
}

function readFilter(bytes: Uint8Array, depth: number): FilterNode {
  if (depth > MAX_FILTER_DEPTH) throw new UnsupportedShape('filter tree nests deeper than this reader descends');
  let node: FilterNode | null = null;
  for (const field of fields(bytes)) {
    if (field.kind !== 'bytes') continue;
    switch (field.number) {
      case FILTER_COMPOSITE:
        node = readCompositeFilter(field.value, depth);
        break;
      case FILTER_FIELD:
        node = readFieldFilter(field.value);
        break;
      case FILTER_UNARY:
        node = readUnaryFilter(field.value);
        break;
      default:
        break;
    }
  }
  if (node === null) throw new UnsupportedShape('filter holds no recognised variant');
  return node;
}

function readCompositeFilter(bytes: Uint8Array, depth: number): FilterNode {
  let op: CompositeOperator | null = null;
  const filters: FilterNode[] = [];
  for (const field of fields(bytes)) {
    if (field.number === COMPOSITE_OP && field.kind === 'varint') {
      op = COMPOSITE_OPERATORS.get(enumeration(field.value)) ?? null;
    } else if (field.number === COMPOSITE_FILTERS && field.kind === 'bytes') {
      filters.push(readFilter(field.value, depth + 1));
    }
  }
  if (op === null) throw new UnsupportedShape('composite filter has no named operator');
  return { op, filters };
}

function readFieldFilter(bytes: Uint8Array): FilterNode {
  let fieldPath: string | null = null;
  let op: FieldOperator | null = null;
  for (const field of fields(bytes)) {
    if (field.number === FIELD_FILTER_FIELD && field.kind === 'bytes') {
      fieldPath = readFieldReference(field.value);
    } else if (field.number === FIELD_FILTER_OP && field.kind === 'varint') {
      op = FIELD_OPERATORS.get(enumeration(field.value)) ?? null;
    }
  }
  if (fieldPath === null || op === null) throw new UnsupportedShape('field filter is not nameable');
  return { fieldPath, op };
}

function readUnaryFilter(bytes: Uint8Array): FilterNode {
  let fieldPath: string | null = null;
  let op: UnaryOperator | null = null;
  for (const field of fields(bytes)) {
    if (field.number === UNARY_FILTER_FIELD && field.kind === 'bytes') {
      fieldPath = readFieldReference(field.value);
    } else if (field.number === UNARY_FILTER_OP && field.kind === 'varint') {
      op = UNARY_OPERATORS.get(enumeration(field.value)) ?? null;
    }
  }
  if (fieldPath === null || op === null) throw new UnsupportedShape('unary filter is not nameable');
  return { fieldPath, op };
}

function readOrder(bytes: Uint8Array): Order {
  let fieldPath: string | null = null;
  // SPEC §7: `Order.direction` is documented to default to ASCENDING, so an unset direction is
  // Firestore's own statement of what the value means rather than a guess this package makes.
  let direction: Direction = 'ASCENDING';
  for (const field of fields(bytes)) {
    if (field.number === ORDER_FIELD && field.kind === 'bytes') {
      fieldPath = readFieldReference(field.value);
    } else if (field.number === ORDER_DIRECTION && field.kind === 'varint') {
      const value = enumeration(field.value);
      if (value === 1 || value === 0) direction = 'ASCENDING';
      else if (value === 2) direction = 'DESCENDING';
      else throw new UnsupportedShape(`order direction ${value} has no published meaning`);
    }
  }
  if (fieldPath === null) throw new UnsupportedShape('order names no field');
  return { fieldPath, direction };
}

function readFieldReference(bytes: Uint8Array): string {
  let path: string | null = null;
  for (const field of fields(bytes)) {
    if (field.number === FIELD_REFERENCE_PATH && field.kind === 'bytes') path = text(field.value);
  }
  if (path === null || path.length === 0) throw new UnsupportedShape('field reference has no path');
  return path;
}
