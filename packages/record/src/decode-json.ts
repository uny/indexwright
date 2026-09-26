/**
 * Decode the JSON form of a `RunQueryRequest` or `ListenRequest`, as the Firebase Web SDK sends
 * them (issue #58).
 *
 * The Web SDK does not speak gRPC to the emulator. `firebase/firestore/lite` posts a
 * `RunQueryRequest` as JSON to the REST `documents:runQuery` endpoint, in Node as well as in a
 * browser; the full SDK in a browser sends every query — `getDocs` included — as a `ListenRequest`
 * carried by a WebChannel forward channel. Both are the proto3 JSON mapping of the same messages
 * `decode.ts` reads as protobuf: enums as their names, and a field at its default value left out.
 * This reader produces the same `RawQuery`, so the corpus does not know which transport carried a
 * shape (SPEC §7: a query is a shape).
 *
 * A field is read under either of the two spellings the mapping defines — the lowerCamelCase name
 * the Firebase SDKs emit, and the original `snake_case` proto name a conforming parser must also
 * accept. Reading only the first would not merely miss a field: `all_descendants`, `order_by` and
 * `find_nearest` would each fall through as an unknown key, and the query would be *recorded under
 * the wrong shape* rather than declined — a collection-group query written down as a collection one,
 * a vector query written down as a plain one. The proxy reads the wire rather than the source, so
 * the client that wrote these bytes need not be a Firebase SDK.
 *
 * The mapping is otherwise read strictly. A key this reader does not expect is ignored, as protobuf
 * ignores an unknown field number; a value of the wrong type under a key it does expect is a message
 * it cannot vouch for, and is declined as `undecodable-message` rather than read around.
 */
import { declined, MAX_FILTER_DEPTH, UnsupportedShape, VectorQuery } from './decode.js';
import type { AggregationDecodeResult, DecodeResult } from './decode.js';
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
  UnaryOperator,
} from './types.js';
import { WireError } from './wire.js';

const COMPOSITE_OPERATORS = new Set<CompositeOperator>(['AND', 'OR']);

const FIELD_OPERATORS = new Set<FieldOperator>([
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
]);

const UNARY_OPERATORS = new Set<UnaryOperator>(['IS_NAN', 'IS_NULL', 'IS_NOT_NAN', 'IS_NOT_NULL']);

/** Decode the body of a REST `documents:runQuery` request. */
export function decodeJsonRunQuery(body: Uint8Array): DecodeResult {
  try {
    const request = parseObject(body);
    const query = field(request, 'structuredQuery');
    if (query === undefined) throw new UnsupportedShape('request carries no structured query');
    return { ok: true, query: readStructuredQuery(query) };
  } catch (error) {
    return declined(error);
  }
}

/**
 * Decode the body of a REST `documents:runAggregationQuery` request (issue #93).
 *
 * `structuredAggregationQuery`/`structured_aggregation_query` is the same `field()`-mediated
 * either-spelling read every other member of this reader uses; see the module docblock.
 */
export function decodeJsonRunAggregationQuery(body: Uint8Array): AggregationDecodeResult {
  try {
    const request = parseObject(body);
    const query = field(request, 'structuredAggregationQuery');
    if (query === undefined) throw new UnsupportedShape('request carries no structured aggregation query');
    return { ok: true, query: readStructuredAggregationQuery(query) };
  } catch (error) {
    return declined(error) as AggregationDecodeResult;
  }
}

/**
 * Decode one `ListenRequest` off a WebChannel forward channel.
 *
 * `null` for a message that carries no query, the way `decodeListen` answers a `remove_target` or a
 * documents target: control traffic is neither a shape nor a skip.
 */
export function decodeJsonListen(message: string): DecodeResult | null {
  let query: unknown;
  try {
    const request = parseObject(message);
    // The JSON mapping writes one member of a oneof, so unlike the protobuf reader there is no
    // "last one wins" to apply; a message naming both is one the client did not send.
    const target = field(request, 'addTarget');
    if (target === undefined || field(request, 'removeTarget') !== undefined) return null;
    const queryTarget = field(object(target, 'addTarget'), 'query');
    if (queryTarget === undefined) return null;
    query = field(object(queryTarget, 'addTarget.query'), 'structuredQuery');
    if (query === undefined) throw new UnsupportedShape('query target carries no structured query');
  } catch (error) {
    return declined(error);
  }
  try {
    return { ok: true, query: readStructuredQuery(query) };
  } catch (error) {
    return declined(error);
  }
}

/**
 * The messages a WebChannel forward-channel POST carries, in order.
 *
 * The body is `application/x-www-form-urlencoded`: `count=N&ofs=M&req0___data__=…&req1___data__=…`,
 * each `reqN___data__` holding one JSON-encoded request, plus a `headers=` on the first POST of a
 * channel. Nothing here is read but the `reqN___data__` keys, and `N` is what orders them — the
 * client numbers them from zero within one POST.
 *
 * `count` is not read for the messages, but it is held against them. It is the body's own statement
 * of how many it carries, so a body that says one and yields none is a message this reader did not
 * understand — and, left unchecked, one that would leave no shape and no skip behind. That is the
 * tripwire: were the `reqN___data__` spelling ever to change under us, the POSTs would come out
 * empty and the corpus would look complete rather than count them (SPEC §7).
 */
export function forwardChannelMessages(body: Uint8Array): string[] {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new WireError('forward channel body is not UTF-8');
  }
  const messages: { index: number; data: string }[] = [];
  for (const [key, value] of params) {
    const match = /^req(\d+)___data__$/.exec(key);
    if (match === null) continue;
    messages.push({ index: Number(match[1]), data: value });
  }
  const stated = params.get('count');
  if (stated !== null) {
    // Only what the body itself asserts, and only against how many were found. The numbering is
    // left alone: a gap in it is the client's business, and modelling more of the framing than is
    // read would decline bodies this reader has no quarrel with.
    if (!/^\d+$/.test(stated) || Number(stated) !== messages.length) {
      throw new WireError(`forward channel declares ${stated} message(s) and carries ${messages.length}`);
    }
  }
  return messages.sort((a, b) => a.index - b.index).map((entry) => entry.data);
}

type JsonObject = Record<string, unknown>;

function parseObject(source: Uint8Array | string): JsonObject {
  let parsed: unknown;
  try {
    const text = typeof source === 'string' ? source : new TextDecoder('utf-8', { fatal: true }).decode(source);
    parsed = JSON.parse(text);
  } catch {
    throw new WireError('body is not JSON');
  }
  return object(parsed, 'request');
}

function object(value: unknown, what: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WireError(`${what} is not an object`);
  }
  return value as JsonObject;
}

/**
 * One field, under either name the proto3 JSON mapping gives it.
 *
 * A name with no capital in it spells the same either way, so this is the identity for `from`,
 * `where` and the rest; it is applied to every read anyway, because which names those are is a
 * property of the proto and not of this file. A message naming both spellings of one field is one
 * no conforming writer emits, and there is no rule for which to believe — it is declined.
 */
function field(holder: JsonObject, name: string): unknown {
  const original = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  if (original === name) return holder[name];
  const camel = holder[name];
  const snake = holder[original];
  if (camel !== undefined && snake !== undefined) {
    throw new WireError(`${name} is named twice, as ${name} and as ${original}`);
  }
  return camel !== undefined ? camel : snake;
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new WireError(`${what} is not an array`);
  return value;
}

function string(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new WireError(`${what} is not a string`);
  return value;
}

function readStructuredQuery(value: unknown): RawQuery {
  const query = object(value, 'structuredQuery');
  if (field(query, 'findNearest') !== undefined) throw new VectorQuery('query carries a findNearest clause');

  // SPEC §7: an entry holds exactly one collectionGroup, so a query that does not name exactly one
  // collection is skipped because the corpus cannot say what it means — not because it is unknown.
  const from = field(query, 'from');
  const selectors = from === undefined ? [] : array(from, 'from');
  const [selector] = selectors;
  if (selectors.length !== 1 || selector === undefined) {
    throw new UnsupportedShape('query does not name exactly one collection');
  }
  const { collectionId, allDescendants } = readCollectionSelector(selector);
  if (collectionId === null) throw new UnsupportedShape('query does not name exactly one collection');

  const filter = field(query, 'where');
  const where = filter === undefined ? null : readFilter(filter, 1);
  const orders = field(query, 'orderBy');
  const orderBy = orders === undefined ? [] : array(orders, 'orderBy').map(readOrder);

  return {
    collectionGroup: collectionId,
    queryScope: allDescendants ? 'COLLECTION_GROUP' : 'COLLECTION',
    where,
    orderBy,
  };
}

/**
 * The `structuredAggregationQuery` object: the inner `structuredQuery` plus the `aggregations` list.
 * The inner query goes through `readStructuredQuery`, the same function `documents:runQuery` uses,
 * so the filter-depth ceiling and the `find_nearest` refusal apply here without restating either.
 */
function readStructuredAggregationQuery(value: unknown): RawAggregationQuery {
  const agg = object(value, 'structuredAggregationQuery');
  const inner = field(agg, 'structuredQuery');
  if (inner === undefined) throw new UnsupportedShape('aggregation query carries no structured query');
  const list = field(agg, 'aggregations');
  const items = list === undefined ? [] : array(list, 'aggregations');
  // The proto requires at least one; an empty list is a message no conforming client sends.
  if (items.length === 0) throw new UnsupportedShape('aggregation query carries no aggregations');
  return { query: readStructuredQuery(inner), aggregations: items.map(readAggregation) };
}

/** One `aggregations[]` entry. `count`/`sum`/`avg` is a `oneof`; the first present, in that order, is read. */
function readAggregation(value: unknown): AggregationSpec {
  const agg = object(value, 'aggregations[]');
  const count = field(agg, 'count');
  if (count !== undefined) return { op: 'COUNT' as AggregationOp, field: null };
  const sum = field(agg, 'sum');
  if (sum !== undefined) return { op: 'SUM' as AggregationOp, field: readAggregateFunctionField(sum, 'sum') };
  const avg = field(agg, 'avg');
  if (avg !== undefined) return { op: 'AVG' as AggregationOp, field: readAggregateFunctionField(avg, 'avg') };
  throw new UnsupportedShape('aggregation holds no recognised operator');
}

function readAggregateFunctionField(value: unknown, what: string): string {
  const holder = object(value, what);
  const reference = field(holder, 'field');
  if (reference === undefined) throw new UnsupportedShape(`${what} aggregation names no field`);
  return readFieldReference(reference);
}

function readCollectionSelector(value: unknown): { collectionId: string | null; allDescendants: boolean } {
  const selector = object(value, 'from[]');
  const named = field(selector, 'collectionId');
  const collectionId = named === undefined ? '' : string(named, 'collectionId');
  const allDescendants = field(selector, 'allDescendants');
  if (allDescendants !== undefined && typeof allDescendants !== 'boolean') {
    throw new WireError('allDescendants is not a boolean');
  }
  // An empty collection_id is how a `from` names no collection at all.
  return { collectionId: collectionId.length > 0 ? collectionId : null, allDescendants: allDescendants === true };
}

function readFilter(value: unknown, depth: number): FilterNode {
  if (depth > MAX_FILTER_DEPTH) throw new UnsupportedShape('filter tree nests deeper than this reader descends');
  const filter = object(value, 'filter');
  const composite = field(filter, 'compositeFilter');
  if (composite !== undefined) return readCompositeFilter(composite, depth);
  const byField = field(filter, 'fieldFilter');
  if (byField !== undefined) return readFieldFilter(byField);
  const unary = field(filter, 'unaryFilter');
  if (unary !== undefined) return readUnaryFilter(unary);
  throw new UnsupportedShape('filter holds no recognised variant');
}

function readCompositeFilter(value: unknown, depth: number): FilterNode {
  const composite = object(value, 'compositeFilter');
  const named = field(composite, 'op');
  const op = named === undefined ? '' : string(named, 'compositeFilter.op');
  if (!COMPOSITE_OPERATORS.has(op as CompositeOperator)) {
    throw new UnsupportedShape('composite filter has no named operator');
  }
  const children = field(composite, 'filters');
  const filters = children === undefined ? [] : array(children, 'compositeFilter.filters');
  return { op: op as CompositeOperator, filters: filters.map((child) => readFilter(child, depth + 1)) };
}

function readFieldFilter(value: unknown): FilterNode {
  const filter = object(value, 'fieldFilter');
  const named = field(filter, 'op');
  const op = named === undefined ? '' : string(named, 'fieldFilter.op');
  const reference = field(filter, 'field');
  if (reference === undefined || !FIELD_OPERATORS.has(op as FieldOperator)) {
    throw new UnsupportedShape('field filter is not nameable');
  }
  return { fieldPath: readFieldReference(reference), op: op as FieldOperator };
}

function readUnaryFilter(value: unknown): FilterNode {
  const filter = object(value, 'unaryFilter');
  const named = field(filter, 'op');
  const op = named === undefined ? '' : string(named, 'unaryFilter.op');
  const reference = field(filter, 'field');
  if (reference === undefined || !UNARY_OPERATORS.has(op as UnaryOperator)) {
    throw new UnsupportedShape('unary filter is not nameable');
  }
  return { fieldPath: readFieldReference(reference), op: op as UnaryOperator };
}

function readOrder(value: unknown): Order {
  const order = object(value, 'orderBy[]');
  const reference = field(order, 'field');
  if (reference === undefined) throw new UnsupportedShape('order names no field');
  // SPEC §7: `Order.direction` is documented to default to ASCENDING, so an unset direction is
  // Firestore's own statement of what the value means rather than a guess this package makes.
  let direction: Direction = 'ASCENDING';
  const stated = field(order, 'direction');
  if (stated !== undefined) {
    const named = string(stated, 'direction');
    if (named === 'ASCENDING' || named === 'DIRECTION_UNSPECIFIED') direction = 'ASCENDING';
    else if (named === 'DESCENDING') direction = 'DESCENDING';
    else throw new UnsupportedShape('order direction has no published meaning');
  }
  return { fieldPath: readFieldReference(reference), direction };
}

function readFieldReference(value: unknown): string {
  const reference = object(value, 'field');
  const named = field(reference, 'fieldPath');
  const path = named === undefined ? '' : string(named, 'fieldPath');
  if (path.length === 0) throw new UnsupportedShape('field reference has no path');
  return path;
}
