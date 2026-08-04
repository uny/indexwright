import { getRule } from '../rules/index.js';
import { RULE_IDS } from '../types.js';
import type { Finding, LintResult, RuleId } from '../types.js';
import { oneLine } from './inline.js';

/**
 * No finding may read as authorisation to delete an index (SPEC §2), so the summary says so
 * outright rather than leaving the reader to infer it.
 */
const DISCLAIMER =
  'Advisory only: no finding indicates that an index is unused or safe to delete.';

export function formatText(result: LintResult): string {
  const lines: string[] = [];

  for (const [rule, findings] of groupByRule(result.findings)) {
    lines.push(`${rule}  ${getRule(rule).description}`);
    let currentFile = '';
    for (const finding of findings) {
      if (finding.file !== currentFile) {
        currentFile = finding.file;
        lines.push(`  ${oneLine(currentFile)}`);
      }
      lines.push(`    ${oneLine(finding.message)}`);
      for (const key of [finding.key, ...finding.related]) {
        if (key !== null) lines.push(`      ${oneLine(key)}`);
      }
    }
    lines.push('');
  }

  if (result.errors.length > 0) {
    lines.push('could not be analysed');
    for (const error of result.errors) {
      lines.push(`  ${oneLine(error.file)}: ${oneLine(error.message)}`);
    }
    lines.push('');
  }

  lines.push(summarise(result));
  return `${lines.join('\n')}\n`;
}

function summarise(result: LintResult): string {
  const { warnings, errors } = result.summary;
  const scope = `${count(result.files.length, 'file')}, ${count(Object.keys(result.summary.byRule).length, 'rule')}`;

  if (warnings === 0 && errors === 0) return `No findings (${scope}).`;

  const parts = [count(warnings, 'warning')];
  if (errors > 0) parts.push(count(errors, 'error'));
  return `${parts.join(', ')} (${scope}). ${DISCLAIMER}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function groupByRule(findings: readonly Finding[]): Array<[RuleId, Finding[]]> {
  const groups = new Map<RuleId, Finding[]>();
  for (const finding of findings) {
    const bucket = groups.get(finding.rule);
    if (bucket) bucket.push(finding);
    else groups.set(finding.rule, [finding]);
  }
  // Findings arrive sorted by file first, so first-seen order is not the rule order.
  return RULE_IDS.flatMap((id) => {
    const bucket = groups.get(id);
    return bucket ? [[id, bucket] as [RuleId, Finding[]]] : [];
  });
}
