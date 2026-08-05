import type { Finding, Rule, RuleContext } from '../types.js';

/**
 * R4 · quota-headroom — the file is approaching the per-database composite index limit.
 *
 * The limit is reached gradually and silently; the first symptom is a failed index creation at
 * deploy time, which is a poor moment to discover it. Reporting headroom continuously makes the
 * trend visible.
 */
export const quotaHeadroom: Rule = {
  id: 'quota-headroom',
  description: 'the declared index count is close to the per-database limit',

  check(context: RuleContext): Finding[] {
    const { quota, quotaThreshold } = context.options;
    const count = context.document.indexes.length;
    if (count <= quota * quotaThreshold) return [];

    const remaining = quota - count;
    const headroom =
      remaining > 0
        ? `${remaining} left before the limit`
        : remaining === 0
          ? 'the limit is exactly reached'
          : `${-remaining} over the limit`;
    const percent = formatPercent(quotaThreshold);

    return [
      {
        rule: 'quota-headroom',
        file: context.file,
        // The subject is the file, not any one index (SPEC §5, R4).
        key: null,
        message:
          `${count} composite indexes declared, above ${percent} of the ${quota}-index limit ` +
          `(${headroom}). Index creation fails once the limit is reached, at deploy time.`,
        related: [],
      },
    ];
  },
};

function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}
