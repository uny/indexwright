import { compareStrings, groupBy, uniqueSorted } from '../collections.js';
import type { AnalysedIndex, CanonicalField, Finding, Rule, RuleContext } from '../types.js';

/** A byte no collection id or field path can contain, so grouping keys cannot collide. */
const SEPARATOR = '\u0000';

/**
 * R2 · field-order-variant — indexes over the same field set, declared in different orders.
 *
 * Firestore treats a different field order as a different index, so each variant consumes write
 * amplification, storage, and quota on its own. Distinct orderings can be genuinely required; the
 * finding asks for that justification to be recorded, not for a variant to be removed.
 */
export const fieldOrderVariant: Rule = {
  id: 'field-order-variant',
  description: 'indexes over the same field set declared in different field orders',

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const groups = [...groupBy(context.indexes, fieldSetKey)].sort(([a], [b]) =>
      compareStrings(a, b),
    );

    for (const [, indexes] of groups) {
      if (indexes.length < 2) continue;
      const orderings = uniqueSorted(indexes.map(fieldSequence));
      // Byte-identical declarations are not "different orders" and are not this rule's subject.
      if (orderings.length < 2) continue;

      const first = indexes[0] as AnalysedIndex;
      const keys = uniqueSorted(indexes.map((index) => index.key));
      const fieldList = uniqueSorted(
        first.fields.map((field) => `${field.fieldPath} (${field.direction})`),
      ).join(', ');

      findings.push({
        rule: 'field-order-variant',
        file: context.file,
        key: keys[0] ?? null,
        message:
          `collectionGroup "${first.collectionGroup}" declares ${orderings.length} field orders ` +
          `over the same ${first.queryScope}-scoped fields — ${fieldList}. Firestore stores each ` +
          `order as a separate index; record which query needs which order.`,
        related: keys.slice(1),
      });
    }

    return findings;
  },
};

/**
 * Every boundary is the separator, never `:` or `|`. Directions are not checked against an
 * enumeration (§4), so a direction that itself contains `a:X|b` would otherwise make two different
 * field multisets share one grouping key and fire this rule on indexes that do not share a field
 * set at all.
 */
function pair(field: CanonicalField): string {
  return `${field.fieldPath}${SEPARATOR}${field.direction}`;
}

/**
 * Same collectionGroup, same queryScope, same multiset of field/direction pairs — order ignored.
 * Sorting rather than de-duplicating keeps a repeated fieldPath (§4) from collapsing into one.
 */
function fieldSetKey(index: AnalysedIndex): string {
  const pairs = index.fields.map(pair).sort(compareStrings);
  return [index.collectionGroup, index.queryScope, ...pairs].join(SEPARATOR);
}

function fieldSequence(index: AnalysedIndex): string {
  return index.fields.map(pair).join(SEPARATOR);
}
