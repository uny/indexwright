/**
 * The shapes indexwright reads and produces.
 *
 * The input types mirror `firestore.indexes.json` loosely on purpose: unknown keys are carried
 * through rather than rejected, so a field added by a future Firebase release does not break
 * linting (SPEC §10).
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

/**
 * One entry of a field override's `indexes` array: a single-field index.
 *
 * The same three configs as `IndexField`, minus `fieldPath` — the override names the field once,
 * above — plus the `queryScope` a composite index carries at the top level. A single-field index is
 * one field, so the scope is the only thing that varies from entry to entry besides the direction.
 */
export interface SingleFieldIndex {
  /** `COLLECTION` or `COLLECTION_GROUP` in practice; not validated against an enumeration. */
  queryScope: string;
  order?: string;
  arrayConfig?: string;
  vectorConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * One entry of the document's `fieldOverrides` array.
 *
 * Firestore indexes every field of every document by default; an override replaces that default
 * for one field of one collection group with the set declared in `indexes`. The set is the *whole*
 * configuration the field ends up with, not a delta — an export materialises the defaults an
 * override keeps — and an empty set is an exemption: the field is not indexed at all.
 *
 * `ttl` is carried and not analysed. It decides when a document is deleted, not which queries are
 * served, so nothing that reads a canonical form has a use for it.
 */
export interface FieldOverride {
  collectionGroup: string;
  fieldPath: string;
  indexes: SingleFieldIndex[];
  ttl?: boolean;
  [key: string]: unknown;
}

/** A parsed and validated `firestore.indexes.json`. */
export interface IndexDocument {
  indexes: CompositeIndex[];
  fieldOverrides?: FieldOverride[];
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

/** A single-field index reduced to the two things its canonical form is built from. */
export interface CanonicalSingleFieldIndex {
  queryScope: string;
  /** `ASCENDING`, `DESCENDING`, `CONTAINS`, or `VECTOR(<dimension>)`. */
  direction: string;
}

/**
 * A field override with its canonical form precomputed, the counterpart of `AnalysedIndex`.
 *
 * Built by `analyseOverrides` and shared with `@indexwright/record`, which reconciles it against a
 * live field listing; a rule reading `fieldOverrides` reads this rather than the source (issues #53
 * and #54 ask for one model, not two).
 */
export interface AnalysedOverride {
  /** The declaration as written, including any keys indexwright does not understand. */
  readonly source: FieldOverride;
  /** Position within the document's `fieldOverrides` array, for messages that need to point at one. */
  readonly position: number;
  readonly collectionGroup: string;
  readonly fieldPath: string;
  /**
   * The declared set, in canonical order: sorted by query scope, then direction, with entries alike
   * in both collapsed to one (`source.indexes` keeps them all). Empty for an exemption.
   */
  readonly indexes: readonly CanonicalSingleFieldIndex[];
  readonly key: string;
}

export const RULE_IDS = [
  'scope-mismatch',
  'field-order-variant',
  'explicit-name-field',
  'quota-headroom',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** A single warning. Never an error: see SPEC §8. */
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
