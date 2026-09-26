/**
 * Decode a Firestore `RunQueryRequest` or `ListenRequest` into the shape SPEC §7 records.
 *
 * Field numbers are from the published `google.firestore.v1` definitions. Two of them are easy to
 * get wrong and worth naming: `CollectionSelector.collection_id` and `FieldReference.field_path`
 * are both field **2**, not 1. Reading them as 1 yields a tree with the right structure and no
 * names at all, which parses cleanly and is silently empty. The `Listen` path is three nested
 * field-2s in a row — `ListenRequest.add_target`, `Target.query`, `QueryTarget.structured_query` —
 * and the neighbouring field 3 means something different at each of the first two levels.
 */
import type {
  AggregationOp,
  AggregationSpec,
  CompositeOperator,
  Direction,
  FieldOperator,
  FilterNode,
  Order,
  RawAggregationQuery,
  RawQuery,
  SkipReason,
  UnaryOperator,
} from './types.js';
import { enumeration, fields, text, WireError } from './wire.js';

export type DecodeResult = { readonly ok: true; readonly query: RawQuery } | { readonly ok: false; readonly reason: SkipReason };

export type AggregationDecodeResult =
  | { readonly ok: true; readonly query: RawAggregationQuery }
  | { readonly ok: false; readonly reason: SkipReason };

/** `RunQueryRequest.structured_query`. */
const RUN_QUERY_STRUCTURED_QUERY = 2;

/** `RunAggregationQueryRequest.structured_aggregation_query`. */
const RUN_AGGREGATION_QUERY_STRUCTURED = 2;

/** `StructuredAggregationQuery.structured_query` and `.aggregations`. */
const AGGREGATION_QUERY_STRUCTURED_QUERY = 1;
const AGGREGATION_QUERY_AGGREGATIONS = 3;

/** `StructuredAggregationQuery.Aggregation`'s `operator` oneof: `count`, `sum`, `avg`. `alias` (7) is not read. */
const AGGREGATION_COUNT = 1;
const AGGREGATION_SUM = 2;
const AGGREGATION_AVG = 3;

/** `Sum.field` and `Avg.field`, both a `StructuredQuery.FieldReference` at field 1. `Count.up_to` is not read. */
const AGGREGATE_FUNCTION_FIELD = 1;

/** `ListenRequest.add_target` and `remove_target`, the members of its `target_change` oneof. */
const LISTEN_ADD_TARGET = 2;
const LISTEN_REMOVE_TARGET = 3;
/** `Target.query` and `Target.documents`, the members of its `target_type` oneof. */
const TARGET_QUERY = 2;
const TARGET_DOCUMENTS = 3;
/** `Target.QueryTarget.structured_query`, the only member of its `query_type` oneof. */
const QUERY_TARGET_STRUCTURED_QUERY = 2;

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
export class UnsupportedShape extends Error {
  override readonly name = 'UnsupportedShape';
}

/** A `find_nearest` clause anywhere in the query; skipped as `vector-query`, not as a bad shape. */
export class VectorQuery extends Error {
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
export const MAX_FILTER_DEPTH = 100;

export function decodeRunQuery(message: Uint8Array): DecodeResult {
  return decode(() => readRunQueryRequest(message));
}

/**
 * Decode a `RunAggregationQueryRequest` (issue #93).
 *
 * The `ok: false` branch is structurally identical to `DecodeResult`'s — both are `{ reason:
 * SkipReason }` — so `declined` is reused rather than restated; only the `ok: true` branch's payload
 * type differs; between the two decoders.
 */
export function decodeRunAggregationQuery(message: Uint8Array): AggregationDecodeResult {
  try {
    return { ok: true, query: readRunAggregationQueryRequest(message) };
  } catch (error) {
    return declined(error) as AggregationDecodeResult;
  }
}

/**
 * Decode one message of a `Listen` stream.
 *
 * `null` when the message carries no query to record: a `remove_target`, or an `add_target` whose
 * target names documents rather than a query. Those are the stream's control traffic, and neither
 * a shape nor a skip — counting them would put a `remove_target` in the corpus's account of what
 * the proxy declined.
 */
export function decodeListen(message: Uint8Array): DecodeResult | null {
  let query: Uint8Array | null;
  try {
    query = readListenRequest(message);
  } catch (error) {
    return declined(error);
  }
  if (query === null) return null;
  return decode(() => readStructuredQuery(query));
}

function decode(read: () => RawQuery): DecodeResult {
  try {
    return { ok: true, query: read() };
  } catch (error) {
    return declined(error);
  }
}

export function declined(error: unknown): DecodeResult {
  if (error instanceof VectorQuery) return { ok: false, reason: 'vector-query' };
  if (error instanceof UnsupportedShape) return { ok: false, reason: 'unsupported-shape' };
  if (error instanceof WireError) return { ok: false, reason: 'undecodable-message' };
  throw error;
}

/** The `structured_query` bytes an add_target carries, or `null` for a message that holds none. */
function readListenRequest(message: Uint8Array): Uint8Array | null {
  // Each level is a oneof, so the member that appears last is the one set: an `add_target`
  // followed by a `remove_target` is a remove, and a `query` followed by `documents` names documents.
  let target: Uint8Array | null = null;
  for (const field of fields(message)) {
    if (field.number === LISTEN_ADD_TARGET && field.kind === 'bytes') target = field.value;
    else if (field.number === LISTEN_REMOVE_TARGET && field.kind === 'varint') target = null;
  }
  if (target === null) return null;

  let queryTarget: Uint8Array | null = null;
  for (const field of fields(target)) {
    if (field.number === TARGET_QUERY && field.kind === 'bytes') queryTarget = field.value;
    else if (field.number === TARGET_DOCUMENTS && field.kind === 'bytes') queryTarget = null;
  }
  if (queryTarget === null) return null;

  let query: Uint8Array | null = null;
  for (const field of fields(queryTarget)) {
    if (field.number === QUERY_TARGET_STRUCTURED_QUERY && field.kind === 'bytes') query = field.value;
  }
  if (query === null) throw new UnsupportedShape('query target carries no structured query');
  return query;
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

function readRunAggregationQueryRequest(message: Uint8Array): RawAggregationQuery {
  let query: Uint8Array | null = null;
  for (const field of fields(message)) {
    if (field.number === RUN_AGGREGATION_QUERY_STRUCTURED && field.kind === 'bytes') query = field.value;
  }
  if (query === null) throw new UnsupportedShape('request carries no structured aggregation query');
  return readStructuredAggregationQuery(query);
}

/**
 * The inner query is read by `readStructuredQuery`, the same function `RunQuery` uses — so the
 * filter-depth ceiling (`MAX_FILTER_DEPTH`, issue #68) and the `find_nearest` refusal (`VectorQuery`)
 * apply to an aggregation's inner query exactly as they apply to a plain one, without restating either
 * rule here.
 */
function readStructuredAggregationQuery(bytes: Uint8Array): RawAggregationQuery {
  let structuredQuery: Uint8Array | null = null;
  const aggregations: AggregationSpec[] = [];
  for (const field of fields(bytes)) {
    if (field.number === AGGREGATION_QUERY_STRUCTURED_QUERY && field.kind === 'bytes') {
      structuredQuery = field.value;
    } else if (field.number === AGGREGATION_QUERY_AGGREGATIONS && field.kind === 'bytes') {
      aggregations.push(readAggregation(field.value));
    }
  }
  if (structuredQuery === null) throw new UnsupportedShape('aggregation query carries no structured query');
  // The proto requires at least one; an empty list is a message no conforming client sends, and is
  // treated as unnameable rather than replayed as a query with no aggregation at all.
  if (aggregations.length === 0) throw new UnsupportedShape('aggregation query carries no aggregations');
  return { query: readStructuredQuery(structuredQuery), aggregations };
}

/**
 * One `Aggregation`. `count`/`sum`/`avg` is a `oneof`, and the last one present on the wire wins —
 * that is protobuf's own semantics for a repeated field number within one message, the same rule
 * every other oneof in this file follows (`where`, `CompositeFilter.op`, `Order.direction`). This is
 * deliberately *not* mirrored in `decode-json.ts`'s `readAggregation`: the binary wire can legally
 * carry more than one occurrence of a oneof member and defines which one counts, but the proto3 JSON
 * mapping has no such occurrence to order — a JSON object naming two of these keys is not a message
 * a conforming writer produces, and is declined there rather than resolved by a rule the format
 * does not state.
 */
function readAggregation(bytes: Uint8Array): AggregationSpec {
  let op: AggregationOp | null = null;
  let field_: string | null = null;
  for (const field of fields(bytes)) {
    if (field.kind !== 'bytes') continue;
    switch (field.number) {
      case AGGREGATION_COUNT:
        op = 'COUNT';
        field_ = null;
        break;
      case AGGREGATION_SUM:
        op = 'SUM';
        field_ = readAggregateFunctionField(field.value);
        break;
      case AGGREGATION_AVG:
        op = 'AVG';
        field_ = readAggregateFunctionField(field.value);
        break;
      default:
        break;
    }
  }
  // An `Aggregation` naming none of the three is not one this closed vocabulary (SPEC §7's own
  // discipline, restated at `AggregationOp`) can name — skipped rather than guessed at.
  if (op === null) throw new UnsupportedShape('aggregation holds no recognised operator');
  return { op, field: field_ };
}

/** `Sum.field` or `Avg.field`: a single embedded `StructuredQuery.FieldReference`. */
function readAggregateFunctionField(bytes: Uint8Array): string {
  let path: string | null = null;
  for (const field of fields(bytes)) {
    if (field.number === AGGREGATE_FUNCTION_FIELD && field.kind === 'bytes') path = readFieldReference(field.value);
  }
  if (path === null) throw new UnsupportedShape('aggregation field is not nameable');
  return path;
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
