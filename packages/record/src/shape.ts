/**
 * Normalisation and the canonical query key (SPEC §7, *Canonical query key*).
 *
 * The key is what entries de-duplicate on, so it has to be injective: two queries that differ must
 * not serialise alike. That is the whole reason for the escaping below — a corpus in which two
 * queries share an entry is not a gap in coverage, it is a gap that looks like coverage.
 */
import type { FilterComposite, FilterNode, Order, QueryShape, RawQuery } from './types.js';
import { isComposite } from './types.js';

/** The delimiters the key is built from, plus the backslash that escapes them. */
const RESERVED = new Set(['\\', ':', '|', '(', ')']);

/**
 * Escape one component of the key.
 *
 * Applied to enum names too, where it does nothing, so that decoding is uniform: a reader
 * unescapes every component rather than tracking which ones could have needed it.
 */
export function escapeComponent(value: string): string {
  let escaped = '';
  for (const character of value) {
    if (RESERVED.has(character)) escaped += `\\${character}`;
    else if (character < ' ') {
      // Not about ambiguity: SPEC §6 requires that a value read off an untrusted input cannot
      // forge a line of output, and a key holding a raw newline would end the line it is on.
      escaped += `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0')}`;
    } else escaped += character;
  }
  return escaped;
}

/**
 * Compare by Unicode code point.
 *
 * `<` on strings compares UTF-16 code units, which orders an astral character before one in
 * U+E000–U+FFFF. Field paths are arbitrary user strings, so the difference is reachable.
 */
export function compareByCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = (left[i] as string).codePointAt(0) as number;
    const y = (right[i] as string).codePointAt(0) as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

export function serialiseFilter(node: FilterNode): string {
  if (!isComposite(node)) return `${escapeComponent(node.fieldPath)}:${escapeComponent(node.op)}`;
  const children = node.filters.map(serialiseFilter).join('|');
  return `${escapeComponent(node.op)}(${children})`;
}

export function serialiseOrderBy(orderBy: readonly Order[]): string {
  return orderBy
    .map((order) => `${escapeComponent(order.fieldPath)}:${escapeComponent(order.direction)}`)
    .join('|');
}

export function queryKey(shape: Omit<QueryShape, 'key'>): string {
  return [
    escapeComponent(shape.collectionGroup),
    escapeComponent(shape.queryScope),
    serialiseFilter(shape.where),
    serialiseOrderBy(shape.orderBy),
  ].join('::');
}

/**
 * Put a filter tree into the one form the corpus stores.
 *
 * Children are normalised first, so that a chain of same-operator composites collapses all the way
 * rather than one level. `AND` and `OR` are both commutative, so children are then sorted; repeated
 * children are kept, because `tier == "a" OR tier == "b"` is a two-disjunct query and one disjunct
 * would describe a query nobody issued.
 */
export function normaliseFilter(node: FilterNode): FilterNode {
  if (!isComposite(node)) return node;

  const children: FilterNode[] = [];
  for (const child of node.filters) {
    const normalised = normaliseFilter(child);
    // `AND(a|AND(b|c))` and `AND(a|b|c)` are one query. Nesting under a different operator is
    // meaningful and is kept.
    if (isComposite(normalised) && normalised.op === node.op) children.push(...normalised.filters);
    else children.push(normalised);
  }

  children.sort((a, b) => compareByCodePoint(serialiseFilter(a), serialiseFilter(b)));
  return { op: node.op, filters: children };
}

/**
 * The root is always a composite: `StructuredQuery.where` may be a bare field or unary filter, and
 * is then wrapped in an `AND`. A root that is already a composite keeps its own operator, so a
 * top-level `OR` stays `OR(…)` rather than becoming `AND(OR(…))`.
 */
export function normaliseRoot(where: FilterNode | null): FilterComposite {
  if (where === null) return { op: 'AND', filters: [] };
  const normalised = normaliseFilter(where);
  if (isComposite(normalised)) return normalised;
  return { op: 'AND', filters: [normalised] };
}

export function toQueryShape(raw: RawQuery): QueryShape {
  const shape = {
    collectionGroup: raw.collectionGroup,
    queryScope: raw.queryScope,
    where: normaliseRoot(raw.where),
    // Sort order is not commutative and is preserved as sent.
    orderBy: [...raw.orderBy],
  };
  return { key: queryKey(shape), ...shape };
}
