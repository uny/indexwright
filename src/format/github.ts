import type { Finding, LintResult } from '../types.js';

export interface GithubOutput {
  /** Workflow commands, for stdout: GitHub reads them from the job log. */
  commands: string;
  /** Markdown, for `$GITHUB_STEP_SUMMARY`. */
  summary: string;
}

/**
 * Findings are annotations without a line number: locating a finding inside the JSON would need a
 * position-tracking parser, which v0.1.0 does not carry (SPEC §4).
 */
export function formatGithub(result: LintResult): GithubOutput {
  const commands = [
    ...result.findings.map(
      (finding) => `::warning file=${escapeProperty(finding.file)}::${escapeData(annotation(finding))}`,
    ),
    ...result.errors.map(
      (error) => `::error file=${escapeProperty(error.file)}::${escapeData(error.message)}`,
    ),
  ];

  return {
    commands: commands.length > 0 ? `${commands.join('\n')}\n` : '',
    summary: markdown(result),
  };
}

function annotation(finding: Finding): string {
  const keys = [finding.key, ...finding.related].filter((key): key is string => key !== null);
  const suffix = keys.length > 0 ? ` [${keys.join(', ')}]` : '';
  return `${finding.rule}: ${finding.message}${suffix}`;
}

function markdown(result: LintResult): string {
  const lines = ['## indexwright', ''];
  const { warnings, errors } = result.summary;

  if (warnings === 0 && errors === 0) {
    lines.push(`No findings across ${result.files.length} file(s).`, '');
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    `${warnings} warning(s)${errors > 0 ? ` and ${errors} error(s)` : ''} across ` +
      `${result.files.length} file(s).`,
    '',
    '> Advisory only: no finding indicates that an index is unused or safe to delete.',
    '',
  );

  if (warnings > 0) {
    lines.push('| Rule | File | Index | Detail |', '| --- | --- | --- | --- |');
    for (const finding of result.findings) {
      const keys = [finding.key, ...finding.related].filter((key): key is string => key !== null);
      const indexCell =
        keys.length === 0
          ? '_whole file_'
          : keys.map((key) => `\`${escapeCell(key)}\``).join('<br>');
      lines.push(
        `| \`${finding.rule}\` | \`${escapeCell(finding.file)}\` | ${indexCell} | ${escapeCell(finding.message)} |`,
      );
    }
    lines.push('');
  }

  if (errors > 0) {
    lines.push('### Files that could not be analysed', '');
    for (const error of result.errors) {
      lines.push(`- \`${escapeCell(error.file)}\` — ${escapeCell(error.message)}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

/** Canonical keys contain `|`, which would otherwise start a new table cell. */
function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|');
}

function escapeData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}
