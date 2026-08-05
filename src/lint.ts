import { readFileSync } from 'node:fs';
import { compareStrings } from './collections.js';
import { analyse } from './key.js';
import { MalformedInputError, parseDocument } from './parse.js';
import { getRule, rules } from './rules/index.js';
import { RULE_IDS } from './types.js';
import type {
  Finding,
  IndexDocument,
  LintError,
  LintResult,
  RuleId,
  RuleOptions,
} from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_QUOTA = 1000;
export const DEFAULT_QUOTA_THRESHOLD = 0.8;

export interface LintOptions extends Partial<RuleOptions> {
  /** Rules to run, in any order. Defaults to all of them. */
  rules?: readonly RuleId[];
}

export interface DocumentInput {
  file: string;
  document: IndexDocument;
}

export interface TextInput {
  file: string;
  text: string;
}

/** Lint documents that are already parsed. The lowest layer; does no I/O. */
export function lintDocuments(inputs: readonly DocumentInput[], options: LintOptions = {}): LintResult {
  return assemble(
    inputs.map((input) => ({ file: input.file, document: input.document, error: null })),
    options,
  );
}

/** Lint raw file contents. A file that does not parse becomes an error, not a thrown exception. */
export function lintTexts(inputs: readonly TextInput[], options: LintOptions = {}): LintResult {
  return assemble(
    inputs.map((input) => {
      try {
        return { file: input.file, document: parseDocument(input.text), error: null };
      } catch (error) {
        return { file: input.file, document: null, error: describe(error) };
      }
    }),
    options,
  );
}

/** Lint files on disk. Unreadable files are reported the same way malformed ones are. */
export function lintFiles(paths: readonly string[], options: LintOptions = {}): LintResult {
  return assemble(
    paths.map((file) => {
      try {
        return { file, document: parseDocument(readFileSync(file, 'utf8')), error: null };
      } catch (error) {
        return { file, document: null, error: describe(error) };
      }
    }),
    options,
  );
}

interface LoadedFile {
  file: string;
  document: IndexDocument | null;
  error: string | null;
}

function assemble(loaded: readonly LoadedFile[], options: LintOptions): LintResult {
  const selected = resolveRules(options.rules);
  const ruleOptions: RuleOptions = {
    quota: options.quota ?? DEFAULT_QUOTA,
    quotaThreshold: options.quotaThreshold ?? DEFAULT_QUOTA_THRESHOLD,
  };

  const findings: Finding[] = [];
  const errors: LintError[] = [];

  for (const entry of loaded) {
    if (!entry.document) {
      errors.push({ file: entry.file, message: entry.error ?? 'could not be read' });
      continue;
    }
    const context = {
      file: entry.file,
      document: entry.document,
      indexes: analyse(entry.document),
      options: ruleOptions,
    };
    for (const id of selected) {
      findings.push(...getRule(id).check(context));
    }
  }

  findings.sort(compareFindings);
  errors.sort((a, b) => compareStrings(a.file, b.file));

  const byRule: Record<string, number> = {};
  for (const id of selected) byRule[id] = 0;
  for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;

  return {
    version: VERSION,
    files: [...loaded.map((entry) => entry.file)].sort(compareStrings),
    summary: { warnings: findings.length, errors: errors.length, byRule },
    findings,
    errors,
  };
}

/** Preserve the canonical rule order (SPEC §5) whatever order the caller asked in. */
function resolveRules(requested: readonly RuleId[] | undefined): RuleId[] {
  if (!requested) return rules.map((rule) => rule.id);
  const wanted = new Set(requested);
  return RULE_IDS.filter((id) => wanted.has(id));
}

const RULE_ORDER = new Map<RuleId, number>(RULE_IDS.map((id, position) => [id, position]));

function compareFindings(a: Finding, b: Finding): number {
  return (
    compareStrings(a.file, b.file) ||
    (RULE_ORDER.get(a.rule) ?? 0) - (RULE_ORDER.get(b.rule) ?? 0) ||
    compareKeys(a.key, b.key) ||
    compareStrings(a.message, b.message)
  );
}

/** A null key sorts first: it belongs to a file-wide finding, which has no index to sort by. */
function compareKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareStrings(a, b);
}

function describe(error: unknown): string {
  if (error instanceof MalformedInputError) return error.message;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EISDIR') return 'is a directory';
  if (code === 'EACCES') return 'permission denied';
  return error instanceof Error ? error.message : String(error);
}
