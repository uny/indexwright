import { DEFAULT_QUOTA, DEFAULT_QUOTA_THRESHOLD } from './lint.js';
import { isRuleId, rules } from './rules/index.js';
import { RULE_IDS } from './types.js';
import type { OutputFormat, RuleId } from './types.js';

/** Anything the user could have typed differently. Mapped to exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface LintCommand {
  kind: 'lint';
  files: string[];
  format: OutputFormat;
  maxWarnings: number;
  rules: RuleId[];
  quota: number;
  quotaThreshold: number;
}

export type Command = LintCommand | { kind: 'help' } | { kind: 'version' };

const FORMATS: readonly OutputFormat[] = ['text', 'json', 'github'];

/**
 * Parsed in-tree rather than with a dependency (SPEC §8). Supports `--flag value` and
 * `--flag=value`, and `--` to end option parsing.
 */
export function parseArgs(argv: readonly string[]): Command {
  if (argv.length === 0) throw new UsageError('no command given');
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  if (argv.includes('--version')) return { kind: 'version' };

  const [command, ...rest] = argv;
  if (command !== 'lint') {
    throw new UsageError(`unknown command "${command}"; the only command is "lint"`);
  }

  const files: string[] = [];
  let format: OutputFormat = 'text';
  let maxWarnings = Number.POSITIVE_INFINITY;
  let quota = DEFAULT_QUOTA;
  let quotaThreshold = DEFAULT_QUOTA_THRESHOLD;
  const selected: RuleId[] = [];
  const disabled: RuleId[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const argument = rest[i] as string;

    if (argument === '--') {
      files.push(...rest.slice(i + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      files.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? null : argument.slice(equals + 1);
    const takeValue = (): string => {
      if (inlineValue !== null) return inlineValue;
      const next = rest[i + 1];
      if (next === undefined) throw new UsageError(`${name} needs a value`);
      i += 1;
      return next;
    };

    switch (name) {
      case '--format':
        format = parseFormat(takeValue());
        break;
      case '--max-warnings':
        maxWarnings = parseCount(takeValue(), name);
        break;
      case '--rule':
        selected.push(parseRuleId(takeValue(), name));
        break;
      case '--disable':
        disabled.push(parseRuleId(takeValue(), name));
        break;
      case '--quota':
        quota = parsePositiveInteger(takeValue(), name);
        break;
      case '--quota-threshold':
        quotaThreshold = parseFraction(takeValue(), name);
        break;
      default:
        throw new UsageError(`unknown option "${name}"`);
    }
  }

  if (files.length === 0) throw new UsageError('no input files given');

  return {
    kind: 'lint',
    // De-duplicated so a shell glob that repeats a path does not double every finding.
    files: [...new Set(files)],
    format,
    maxWarnings,
    rules: resolveRules(selected, disabled),
    quota,
    quotaThreshold,
  };
}

function resolveRules(selected: readonly RuleId[], disabled: readonly RuleId[]): RuleId[] {
  const base = selected.length > 0 ? new Set(selected) : new Set<RuleId>(RULE_IDS);
  for (const id of disabled) base.delete(id);
  if (base.size === 0) {
    throw new UsageError('--rule and --disable leave no rules to run');
  }
  return RULE_IDS.filter((id) => base.has(id));
}

function parseFormat(value: string): OutputFormat {
  if (!FORMATS.includes(value as OutputFormat)) {
    throw new UsageError(`unknown format "${value}"; expected one of ${FORMATS.join(', ')}`);
  }
  return value as OutputFormat;
}

/** A typo must not silently produce a clean run, so an unknown rule id is a usage error. */
function parseRuleId(value: string, option: string): RuleId {
  if (!isRuleId(value)) {
    throw new UsageError(`unknown rule "${value}" for ${option}; expected one of ${RULE_IDS.join(', ')}`);
  }
  return value;
}

/** A plain decimal numeral, with or without a fractional part: `5`, `0.8`, `.8`, `-1`. */
const DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/;

/**
 * `Number` reads `""` as 0, ignores surrounding whitespace, and reads `"0x10"` as 16. A CI step
 * that writes `--max-warnings=$LIMIT` with `LIMIT` unset would therefore turn "unlimited" into
 * "zero tolerance" silently, so an option value has to be a numeral and nothing else. `NaN` fails
 * every caller's range check, which reports it as the usage error it is.
 */
function toNumber(value: string): number {
  return DECIMAL.test(value) ? Number(value) : Number.NaN;
}

function parseCount(value: string, option: string): number {
  const parsed = toNumber(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${option} needs a non-negative integer, got "${value}"`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = toNumber(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${option} needs a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseFraction(value: string, option: string): number {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new UsageError(`${option} needs a number in (0, 1], got "${value}"`);
  }
  return parsed;
}

export function usage(): string {
  const ruleLines = rules.map((rule) => `  ${rule.id.padEnd(21)}${rule.description}`);
  return [
    'indexwright lint <file...> [options]',
    '',
    'Lints Firestore composite index declarations. Every rule emits warnings, never errors.',
    'No finding indicates that an index is unused or safe to delete.',
    '',
    'Options:',
    '  --format <fmt>        text (default) | json | github',
    '  --max-warnings <n>    exit 1 if warnings exceed n (default: unlimited)',
    '  --rule <id>           run only the given rule; repeatable',
    '  --disable <id>        skip the given rule; repeatable',
    `  --quota <n>           per-database composite index limit (default: ${DEFAULT_QUOTA})`,
    `  --quota-threshold <p> warn above this fraction of the limit (default: ${DEFAULT_QUOTA_THRESHOLD})`,
    '  -h, --help            show this message',
    '      --version         show the version',
    '',
    'Rules:',
    ...ruleLines,
    '',
    'Exit codes:',
    '  0  completed; warnings may have been emitted',
    '  1  warning count exceeded --max-warnings',
    '  2  usage error, unreadable file, or malformed input',
  ].join('\n');
}
