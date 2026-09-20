import type {
  AnalysedIndex,
  AnalysedOverride,
  CanonicalField,
  CanonicalSingleFieldIndex,
  CompositeIndex,
  FieldOverride,
  IndexDocument,
  IndexField,
  SingleFieldIndex,
} from './types.js';
import { compareStrings } from './collections.js';

export const NAME_FIELD = '__name__';

/** The three configs a field can carry, which a composite index's field and a single-field index share. */
export type IndexConfig = Pick<IndexField, 'order' | 'arrayConfig' | 'vectorConfig'>;

/**
 * The direction a field contributes to the canonical key.
 *
 * `parse.ts` guarantees exactly one of `order`, `arrayConfig`, and `vectorConfig` is present, so
 * the fallback is unreachable for validated input.
 */
export function fieldDirection(field: IndexConfig): string {
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

export function formatSingleFieldIndex(index: CanonicalSingleFieldIndex): string {
  return `${index.queryScope}:${index.direction}`;
}

/**
 * The canonical key of a field override (SPEC §5, *Canonical override key*).
 *
 * The same three-part shape as `indexKey`, with the field path where the query scope sits and the
 * scope inside each entry — a single-field index names one field, so what varies per entry is the
 * scope. `indexes` must already be in canonical order; the key is a rendering, not a sort.
 */
export function overrideKey(
  collectionGroup: string,
  fieldPath: string,
  indexes: readonly CanonicalSingleFieldIndex[],
): string {
  return `${collectionGroup}::${fieldPath}::${indexes.map(formatSingleFieldIndex).join('|')}`;
}

/**
 * Reduce an override's declared set to canonical form.
 *
 * A composite index's fields are a sequence and their order is part of the key; an override's
 * indexes are a set, and Firestore holds at most one single-field index per (scope, direction) of
 * a field. So the entries are sorted, and entries that agree on scope and direction are collapsed
 * to one: two spellings of one configuration reach the same key, while two configurations that
 * differ in any member cannot. The collapse reads only what the key reads — two entries alike in
 * scope and direction but differing in a key the form does not see (`density`, `unique`) collapse
 * too, and `source.indexes` keeps both for a consumer that refuses what the key cannot express.
 */
export function canonicalSingleFieldIndexes(
  indexes: readonly SingleFieldIndex[],
): CanonicalSingleFieldIndex[] {
  const seen = new Set<string>();
  const canonical: CanonicalSingleFieldIndex[] = [];
  for (const index of indexes) {
    const entry = { queryScope: index.queryScope, direction: fieldDirection(index) };
    // Not the rendered `scope:direction`, which is not injective — nothing forbids `:` in either
    // part. `JSON.stringify` over the pair is, without an assumption about the vocabulary.
    const identity = JSON.stringify([entry.queryScope, entry.direction]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    canonical.push(entry);
  }
  return canonical.sort(
    (a, b) => compareStrings(a.queryScope, b.queryScope) || compareStrings(a.direction, b.direction),
  );
}

/**
 * The counterpart of `analyse` for the document's other half. An absent `fieldOverrides` is an
 * empty set, which is what a hand-written file without the key means.
 */
export function analyseOverrides(document: IndexDocument): AnalysedOverride[] {
  return (document.fieldOverrides ?? []).map((source, position) =>
    analyseOverride(source, position),
  );
}

function analyseOverride(source: FieldOverride, position: number): AnalysedOverride {
  const indexes = canonicalSingleFieldIndexes(source.indexes);
  return {
    source,
    position,
    collectionGroup: source.collectionGroup,
    fieldPath: source.fieldPath,
    indexes,
    key: overrideKey(source.collectionGroup, source.fieldPath, indexes),
  };
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
