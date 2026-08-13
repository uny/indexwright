/**
 * The JavaScript API.
 *
 * Provisional before 1.0 (SPEC §10): only the `json` output shape carries the compatibility promise.
 * This exists so the rules can be run without spawning a process — from a test, a codemod, or a
 * bespoke reporter.
 */

export { formatGithub, type GithubOutput } from './format/github.js';
export { formatJson } from './format/json.js';
export { formatText } from './format/text.js';
export {
  analyse,
  canonicalFields,
  fieldDirection,
  implicitNameDirection,
  indexKey,
  NAME_FIELD,
} from './key.js';
export {
  DEFAULT_QUOTA,
  DEFAULT_QUOTA_THRESHOLD,
  lintDocuments,
  lintFiles,
  lintTexts,
  type DocumentInput,
  type LintOptions,
  type TextInput,
} from './lint.js';
export { MalformedInputError, parseDocument, validateDocument } from './parse.js';
export { getRule, isRuleId, rules } from './rules/index.js';
export { RULE_IDS } from './types.js';
export type {
  AnalysedIndex,
  CanonicalField,
  CompositeIndex,
  Finding,
  IndexDocument,
  IndexField,
  LintError,
  LintResult,
  LintSummary,
  OutputFormat,
  Rule,
  RuleContext,
  RuleId,
  RuleOptions,
} from './types.js';
export { VERSION } from './version.js';
