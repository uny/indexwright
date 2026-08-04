import type { AnalysedIndex, CanonicalField, CompositeIndex, IndexDocument, IndexField } from './types.js';

export const NAME_FIELD = '__name__';

/**
 * The direction a field contributes to the canonical key.
 *
 * `parse.ts` guarantees exactly one of `order`, `arrayConfig`, and `vectorConfig` is present, so
 * the fallback is unreachable for validated input.
 */
export function fieldDirection(field: IndexField): string {
  if (typeof field.order === 'string') return field.order;
  if (typeof field.arrayConfig === 'string') return field.arrayConfig;
  if (field.vectorConfig) {
    const dimension = field.vectorConfig['dimension'];
    return `VECTOR(${typeof dimension === 'number' ? dimension : '?'})`;
  }
  return 'UNKNOWN';
}

/**
 * The direction Firestore would give the document key it appends to this field list.
 *
 * See SPEC §5, *The implicit `__name__` direction*: the last preceding `order`, or `ASCENDING` when
 * no preceding field carries one. `fields` must already exclude the trailing `__name__` entry.
 */
export function implicitNameDirection(fields: readonly IndexField[]): string {
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    const order = fields[i]?.order;
    if (typeof order === 'string') return order;
  }
  return 'ASCENDING';
}

export interface CanonicalFields {
  fields: CanonicalField[];
  /** Direction of the trailing `__name__` that was removed, or `null` if nothing was removed. */
  redundantNameDirection: string | null;
}

/**
 * Reduce a declaration's fields to canonical form, dropping a trailing `__name__` that merely
 * restates what Firestore appends anyway.
 *
 * The drop is one-sided by design: a `__name__` whose direction differs from the implicit default
 * is meaningful and is kept, so this can fail to merge two spellings of one index but can never
 * merge two distinct indexes.
 */
export function canonicalFields(fields: readonly IndexField[]): CanonicalFields {
  const last = fields[fields.length - 1];
  if (last && last.fieldPath === NAME_FIELD && typeof last.order === 'string') {
    const head = fields.slice(0, -1);
    if (last.order === implicitNameDirection(head)) {
      return { fields: head.map(toCanonicalField), redundantNameDirection: last.order };
    }
  }
  return { fields: fields.map(toCanonicalField), redundantNameDirection: null };
}

function toCanonicalField(field: IndexField): CanonicalField {
  return { fieldPath: field.fieldPath, direction: fieldDirection(field) };
}

export function formatField(field: CanonicalField): string {
  return `${field.fieldPath}:${field.direction}`;
}

export function indexKey(
  collectionGroup: string,
  queryScope: string,
  fields: readonly CanonicalField[],
): string {
  return `${collectionGroup}::${queryScope}::${fields.map(formatField).join('|')}`;
}

/** Precompute the canonical form once so every rule shares one interpretation of the document. */
export function analyse(document: IndexDocument): AnalysedIndex[] {
  return document.indexes.map((source, position) => analyseIndex(source, position));
}

function analyseIndex(source: CompositeIndex, position: number): AnalysedIndex {
  const { fields, redundantNameDirection } = canonicalFields(source.fields);
  return {
    source,
    position,
    collectionGroup: source.collectionGroup,
    queryScope: source.queryScope,
    fields,
    key: indexKey(source.collectionGroup, source.queryScope, fields),
    redundantNameDirection,
  };
}
