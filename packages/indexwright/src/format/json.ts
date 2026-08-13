import type { LintResult } from '../types.js';

/**
 * The stable machine-readable contract (SPEC §6). Field order here is the order in the spec, so a
 * diff of two runs reads the same way the spec does.
 */
export function formatJson(result: LintResult): string {
  const ordered = {
    version: result.version,
    files: result.files,
    summary: {
      warnings: result.summary.warnings,
      errors: result.summary.errors,
      byRule: result.summary.byRule,
    },
    findings: result.findings.map((finding) => ({
      rule: finding.rule,
      file: finding.file,
      key: finding.key,
      message: finding.message,
      related: finding.related,
    })),
    errors: result.errors.map((error) => ({ file: error.file, message: error.message })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
