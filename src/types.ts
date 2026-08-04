/**
 * The shapes indexwright reads and produces.
 *
 * The input types mirror `firestore.indexes.json` loosely on purpose: unknown keys are carried
 * through rather than rejected, so a field added by a future Firebase release does not break
 * linting (SPEC §9).
 */

/** One entry of an index's `fields` array. */
export interface IndexField {
  fieldPath: string;
  /** `ASCENDING` or `DESCENDING` in practice; not validated against an enumeration. */
  order?: string;
  /** `CONTAINS` in practice; not validated against an enumeration. */
  arrayConfig?: string;
  vectorConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One entry of the document's `indexes` array. */
export interface CompositeIndex {
  collectionGroup: string;
  /** `COLLECTION` or `COLLECTION_GROUP` in practice; not validated against an enumeration. */
  queryScope: string;
  fields: IndexField[];
  [key: string]: unknown;
}

/** A parsed and validated `firestore.indexes.json`. */
export interface IndexDocument {
  indexes: CompositeIndex[];
  fieldOverrides?: unknown[];
  [key: string]: unknown;
}

/** A field reduced to the two things the canonical key is built from. */
export interface CanonicalField {
  fieldPath: string;
  /** `ASCENDING`, `DESCENDING`, `CONTAINS`, or `VECTOR(<dimension>)`. */
  direction: string;
}

/** An index with its canonical form precomputed, so every rule shares one interpretation. */
export interface AnalysedIndex {
  /** The declaration as written, including any keys indexwright does not understand. */
  readonly source: CompositeIndex;
  /** Position within the document's `indexes` array, for messages that need to point at one. */
  readonly position: number;
  readonly collectionGroup: string;
  readonly queryScope: string;
  /** Canonicalised fields: a trailing implicit `__name__` has been removed. */
  readonly fields: readonly CanonicalField[];
  readonly key: string;
  /**
   * The direction of a trailing `__name__` that matched the implicit default and was therefore
   * removed, or `null` when the declaration had no redundant `__name__`.
   */
  readonly redundantNameDirection: string | null;
}

export const RULE_IDS = [
  'scope-mismatch',
  'field-order-variant',
  'explicit-name-field',
  'quota-headroom',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** A single warning. Never an error: see SPEC §7. */
export interface Finding {
  rule: RuleId;
  file: string;
  /** `null` when the finding is about the file rather than about one index. */
  key: string | null;
  message: string;
  /** Other keys in the same finding group, sorted ascending. `[]` when there are none. */
  related: string[];
}

/** A file that could not be read or parsed. Distinct from a finding. */
export interface LintError {
  file: string;
  message: string;
}

export interface LintSummary {
  warnings: number;
  errors: number;
  /** One entry per rule that ran, including rules that found nothing. */
  byRule: Record<string, number>;
}

export interface LintResult {
  version: string;
  files: string[];
  summary: LintSummary;
  findings: Finding[];
  errors: LintError[];
}

export interface RuleOptions {
  /** Per-database composite index limit used by `quota-headroom`. */
  quota: number;
  /** Fraction of `quota` above which `quota-headroom` warns. */
  quotaThreshold: number;
}

export interface RuleContext {
  file: string;
  document: IndexDocument;
  indexes: readonly AnalysedIndex[];
  options: RuleOptions;
}

export interface Rule {
  readonly id: RuleId;
  /** One line, used by `--help`. */
  readonly description: string;
  check(context: RuleContext): Finding[];
}

export type OutputFormat = 'text' | 'json' | 'github';
