import { compareStrings, groupBy, uniqueSorted } from '../collections.js';
import type { AnalysedIndex, Finding, Rule, RuleContext } from '../types.js';

/**
 * R1 · scope-mismatch — one `collectionGroup` declaring more than one `queryScope`.
 *
 * A `COLLECTION`-scoped index does not serve a collection-group query, and vice versa, so an
 * odd-one-out is frequently a mistake that only surfaces as a production `FAILED_PRECONDITION`.
 * Querying a collection both ways is legitimate, which is why this warns rather than fails.
 */
export const scopeMismatch: Rule = {
  id: 'scope-mismatch',
  description: 'one collectionGroup declares more than one queryScope',

  check(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const byCollectionGroup = [...groupBy(context.indexes, (index) => index.collectionGroup)].sort(
      ([a], [b]) => compareStrings(a, b),
    );

    for (const [collectionGroup, indexes] of byCollectionGroup) {
      const byScope = groupBy(indexes, (index) => index.queryScope);
      if (byScope.size < 2) continue;

      // Fewest indexes first; ties broken by scope name so the choice never depends on file order.
      const ranked = [...byScope].sort(
        ([aScope, a], [bScope, b]) => a.length - b.length || compareStrings(aScope, bScope),
      );
      const [flaggedScope, flaggedIndexes] = ranked[0] as [string, AnalysedIndex[]];
      const runnerUp = ranked[1] as [string, AnalysedIndex[]];
      const isStrictMinority = flaggedIndexes.length < runnerUp[1].length;

      const census = [...byScope]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([scope, list]) => `${scope} (${list.length})`)
        .join(', ');
      const keys = uniqueSorted(flaggedIndexes.map((index) => index.key));

      const verdict = isStrictMinority
        ? `${flaggedScope} is the minority`
        : 'No scope is in the minority';
      findings.push({
        rule: 'scope-mismatch',
        file: context.file,
        key: keys[0] ?? null,
        message:
          `collectionGroup "${collectionGroup}" declares more than one queryScope: ${census}. ` +
          `${verdict}; confirm that each scope is intended, since an index of one scope does not ` +
          `serve a query of the other.`,
        related: keys.slice(1),
      });
    }

    return findings;
  },
};
