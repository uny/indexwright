/**
 * Decode the JSON form of a `RunQueryRequest` or `ListenRequest`, as the Firebase Web SDK sends
 * them (issue #58).
 *
 * The Web SDK does not speak gRPC to the emulator. `firebase/firestore/lite` posts a
 * `RunQueryRequest` as JSON to the REST `documents:runQuery` endpoint, in Node as well as in a
 * browser; the full SDK in a browser sends every query — `getDocs` included — as a `ListenRequest`
 * carried by a WebChannel forward channel. Both are the proto3 JSON mapping of the same messages
 * `decode.ts` reads as protobuf: field names in lowerCamelCase, enums as their names, and a field at
 * its default value left out. This reader produces the same `RawQuery`, so the corpus does not know
 * which transport carried a shape (SPEC §7: a query is a shape).
 *
 * The mapping is read strictly. A key this reader does not expect is ignored, as protobuf ignores an
 * unknown field number; a value of the wrong type under a key it does expect is a message it cannot
 * vouch for, and is declined as `undecodable-message` rather than read around.
 */
import { declined, MAX_FILTER_DEPTH, UnsupportedShape, VectorQuery } from './decode.js';
import type { DecodeResult } from './decode.js';
import type {
  CompositeOperator,
  Direction,
  FieldOperator,
  FilterNode,
  Order,
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
    const query = request['structuredQuery'];
    if (query === undefined) throw new UnsupportedShape('request carries no structured query');
    return { ok: true, query: readStructuredQuery(query) };
  } catch (error) {
    return declined(error);
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
    const target = request['addTarget'];
    if (target === undefined || request['removeTarget'] !== undefined) return null;
    const queryTarget = object(target, 'addTarget')['query'];
    if (queryTarget === undefined) return null;
    query = object(queryTarget, 'addTarget.query')['structuredQuery'];
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
  if (query['findNearest'] !== undefined) throw new VectorQuery('query carries a findNearest clause');

  // SPEC §7: an entry holds exactly one collectionGroup, so a query that does not name exactly one
  // collection is skipped because the corpus cannot say what it means — not because it is unknown.
  const selectors = query['from'] === undefined ? [] : array(query['from'], 'from');
  const [selector] = selectors;
  if (selectors.length !== 1 || selector === undefined) {
    throw new UnsupportedShape('query does not name exactly one collection');
  }
  const { collectionId, allDescendants } = readCollectionSelector(selector);
  if (collectionId === null) throw new UnsupportedShape('query does not name exactly one collection');

  const where = query['where'] === undefined ? null : readFilter(query['where'], 1);
  const orderBy = query['orderBy'] === undefined ? [] : array(query['orderBy'], 'orderBy').map(readOrder);

  return {
    collectionGroup: collectionId,
    queryScope: allDescendants ? 'COLLECTION_GROUP' : 'COLLECTION',
    where,
    orderBy,
  };
}

function readCollectionSelector(value: unknown): { collectionId: string | null; allDescendants: boolean } {
  const selector = object(value, 'from[]');
  const collectionId = selector['collectionId'] === undefined ? '' : string(selector['collectionId'], 'collectionId');
  const allDescendants = selector['allDescendants'];
  if (allDescendants !== undefined && typeof allDescendants !== 'boolean') {
    throw new WireError('allDescendants is not a boolean');
  }
  // An empty collection_id is how a `from` names no collection at all.
  return { collectionId: collectionId.length > 0 ? collectionId : null, allDescendants: allDescendants === true };
}

function readFilter(value: unknown, depth: number): FilterNode {
  if (depth > MAX_FILTER_DEPTH) throw new UnsupportedShape('filter tree nests deeper than this reader descends');
  const filter = object(value, 'filter');
  if (filter['compositeFilter'] !== undefined) return readCompositeFilter(filter['compositeFilter'], depth);
  if (filter['fieldFilter'] !== undefined) return readFieldFilter(filter['fieldFilter']);
  if (filter['unaryFilter'] !== undefined) return readUnaryFilter(filter['unaryFilter']);
  throw new UnsupportedShape('filter holds no recognised variant');
}

function readCompositeFilter(value: unknown, depth: number): FilterNode {
  const composite = object(value, 'compositeFilter');
  const op = composite['op'] === undefined ? '' : string(composite['op'], 'compositeFilter.op');
  if (!COMPOSITE_OPERATORS.has(op as CompositeOperator)) {
    throw new UnsupportedShape('composite filter has no named operator');
  }
  const filters = composite['filters'] === undefined ? [] : array(composite['filters'], 'compositeFilter.filters');
  return { op: op as CompositeOperator, filters: filters.map((child) => readFilter(child, depth + 1)) };
}

function readFieldFilter(value: unknown): FilterNode {
  const filter = object(value, 'fieldFilter');
  const op = filter['op'] === undefined ? '' : string(filter['op'], 'fieldFilter.op');
  if (filter['field'] === undefined || !FIELD_OPERATORS.has(op as FieldOperator)) {
    throw new UnsupportedShape('field filter is not nameable');
  }
  return { fieldPath: readFieldReference(filter['field']), op: op as FieldOperator };
}

function readUnaryFilter(value: unknown): FilterNode {
  const filter = object(value, 'unaryFilter');
  const op = filter['op'] === undefined ? '' : string(filter['op'], 'unaryFilter.op');
  if (filter['field'] === undefined || !UNARY_OPERATORS.has(op as UnaryOperator)) {
    throw new UnsupportedShape('unary filter is not nameable');
  }
  return { fieldPath: readFieldReference(filter['field']), op: op as UnaryOperator };
}

function readOrder(value: unknown): Order {
  const order = object(value, 'orderBy[]');
  if (order['field'] === undefined) throw new UnsupportedShape('order names no field');
  // SPEC §7: `Order.direction` is documented to default to ASCENDING, so an unset direction is
  // Firestore's own statement of what the value means rather than a guess this package makes.
  let direction: Direction = 'ASCENDING';
  if (order['direction'] !== undefined) {
    const named = string(order['direction'], 'direction');
    if (named === 'ASCENDING' || named === 'DIRECTION_UNSPECIFIED') direction = 'ASCENDING';
    else if (named === 'DESCENDING') direction = 'DESCENDING';
    else throw new UnsupportedShape('order direction has no published meaning');
  }
  return { fieldPath: readFieldReference(order['field']), direction };
}

function readFieldReference(value: unknown): string {
  const reference = object(value, 'field');
  const path = reference['fieldPath'] === undefined ? '' : string(reference['fieldPath'], 'fieldPath');
  if (path.length === 0) throw new UnsupportedShape('field reference has no path');
  return path;
}
