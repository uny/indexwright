import { compareStrings, groupBy, uniqueSorted } from '../collections.js';
import type { AnalysedOverride, Finding, Rule, RuleContext } from '../types.js';

/** A byte no collection id or field path can contain, so grouping keys cannot collide. */
const SEPARATOR = '\u0000';

/**
 * R5 · repeated-field-override — one field of one collection group configured by more than one
 * `fieldOverrides` entry, and the entries disagree.
 *
 * Firestore keeps one configuration per field, and one entry can state any of them, so a second
 * entry is never needed to say something. When the entries disagree, the file does not say which
 * applies: the Firebase CLI applies them in its own sort order and skips any entry the live field
 * already matches, so the outcome depends on the deploying tool and on the database's state, and
 * can change from one deploy to the next without the file changing.
 *
 * Entries that agree decide nothing between them and are not this rule's subject, as byte-identical
 * indexes are not R2's.
 */
export const repeatedFieldOverride: Rule = {
  id: 'repeated-field-override',
  description: 'one field configured by more than one fieldOverrides entry, and they disagree',

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const groups = [
      ...groupBy(
        context.overrides,
        (override) => `${override.collectionGroup}${SEPARATOR}${override.fieldPath}`,
      ),
    ].sort(([a], [b]) => compareStrings(a, b));

    for (const [, overrides] of groups) {
      const configurations = new Set(overrides.map(configuration));
      if (configurations.size < 2) continue;

      const first = overrides[0] as AnalysedOverride;
      // Two entries alike in key but not in `ttl` share one key, so the count and positions carry
      // what `related` cannot.
      const keys = uniqueSorted(overrides.map((override) => override.key));
      const positions = overrides.map((override) => override.position).join(', ');

      findings.push({
        rule: 'repeated-field-override',
        file: context.file,
        key: keys[0] ?? null,
        message:
          `collectionGroup "${first.collectionGroup}" configures field "${first.fieldPath}" in ` +
          `${overrides.length} fieldOverrides entries (positions ${positions}), with ` +
          `${configurations.size} different configurations. Firestore keeps one configuration per ` +
          `field, and which entry takes effect is decided by the deploying tool and the ` +
          `database's current state, not by the file. Declare the field's configuration in one entry.`,
        related: keys.slice(1),
      });
    }

    return findings;
  },
};

/**
 * What a deploy of the entry would configure: the canonical key plus `ttl`, which the key leaves
 * out but the Firebase CLI does not — omitted leaves a TTL policy alone, `false` removes it, and
 * `true` sets it.
 */
function configuration(override: AnalysedOverride): string {
  return JSON.stringify([override.key, override.source.ttl ?? null]);
}
