import type {
  CompositeIndex,
  FieldOverride,
  IndexDocument,
  IndexField,
  SingleFieldIndex,
} from './types.js';

/**
 * A file that is not a usable index declaration. Reported per file and mapped to exit code 2;
 * it never aborts the analysis of the other files (SPEC §4).
 */
export class MalformedInputError extends Error {
  override readonly name = 'MalformedInputError';
}

export function parseDocument(text: string): IndexDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    // The parser quotes the offending source, which can carry newlines; findings are one line each.
    const detail = (error as Error).message.replace(/\s+/g, ' ').trim();
    throw new MalformedInputError(`invalid JSON: ${detail}`);
  }
  return validateDocument(raw);
}

export function validateDocument(raw: unknown): IndexDocument {
  if (!isObject(raw)) {
    throw new MalformedInputError('the top level must be a JSON object');
  }
  const indexes = raw['indexes'];
  if (indexes === undefined) {
    throw new MalformedInputError('missing "indexes"');
  }
  if (!Array.isArray(indexes)) {
    throw new MalformedInputError('"indexes" must be an array');
  }
  const validated = indexes.map((entry, i) => validateIndex(entry, `indexes[${i}]`));

  // Optional, because a hand-written file usually has none and the Firebase CLI omits the key when
  // an export has none. Present, it is validated to the same depth as `indexes`: an override this
  // tool cannot read is one it would otherwise pass through *as* read, and the consumer that
  // reconciles it against a live listing would then vouch for a field it never examined (#53).
  const overrides = raw['fieldOverrides'];
  if (overrides === undefined) {
    return { ...raw, indexes: validated } as IndexDocument;
  }
  if (!Array.isArray(overrides)) {
    throw new MalformedInputError('"fieldOverrides" must be an array');
  }
  const validatedOverrides = overrides.map((entry, i) =>
    validateOverride(entry, `fieldOverrides[${i}]`),
  );
  return { ...raw, indexes: validated, fieldOverrides: validatedOverrides } as IndexDocument;
}

function validateIndex(raw: unknown, path: string): CompositeIndex {
  if (!isObject(raw)) {
    throw new MalformedInputError(`${path}: must be an object`);
  }
  const collectionGroup = requireString(raw['collectionGroup'], `${path}: "collectionGroup"`);
  const queryScope = requireString(raw['queryScope'], `${path}: "queryScope"`);

  const fields = raw['fields'];
  if (!Array.isArray(fields)) {
    throw new MalformedInputError(`${path}: "fields" must be an array`);
  }
  if (fields.length === 0) {
    throw new MalformedInputError(`${path}: "fields" must not be empty`);
  }

  // A repeated fieldPath is odd but occurs in real exports, and refusing to analyse a file is the
  // harshest thing a warn-only tool can do. It is carried through; R2 compares multisets, so the
  // repetition does not make "the same fields" ambiguous (SPEC §4, §5).
  const validatedFields = fields.map((entry, i) => validateField(entry, `${path}.fields[${i}]`));

  return { ...raw, collectionGroup, queryScope, fields: validatedFields } as CompositeIndex;
}

function validateField(raw: unknown, path: string): IndexField {
  if (!isObject(raw)) {
    throw new MalformedInputError(`${path}: must be an object`);
  }
  const fieldPath = requireString(raw['fieldPath'], `${path}: "fieldPath"`);
  validateConfig(raw, path);
  return { ...raw, fieldPath } as IndexField;
}

function validateOverride(raw: unknown, path: string): FieldOverride {
  if (!isObject(raw)) {
    throw new MalformedInputError(`${path}: must be an object`);
  }
  const collectionGroup = requireString(raw['collectionGroup'], `${path}: "collectionGroup"`);
  const fieldPath = requireString(raw['fieldPath'], `${path}: "fieldPath"`);

  // Empty is not the error it is for a composite index: an override declaring no indexes is an
  // exemption, which is a configuration Firestore holds and an export writes out.
  const indexes = raw['indexes'];
  if (!Array.isArray(indexes)) {
    throw new MalformedInputError(`${path}: "indexes" must be an array`);
  }
  const validatedIndexes = indexes.map((entry, i) =>
    validateSingleFieldIndex(entry, `${path}.indexes[${i}]`),
  );

  // Checked for type only. Whether the field has a TTL policy is not something a canonical form
  // reads, but a value that is not a boolean is not a TTL declaration the Firebase CLI would write.
  if (raw['ttl'] !== undefined && typeof raw['ttl'] !== 'boolean') {
    throw new MalformedInputError(`${path}: "ttl" must be a boolean`);
  }

  return { ...raw, collectionGroup, fieldPath, indexes: validatedIndexes } as FieldOverride;
}

function validateSingleFieldIndex(raw: unknown, path: string): SingleFieldIndex {
  if (!isObject(raw)) {
    throw new MalformedInputError(`${path}: must be an object`);
  }
  // Absent, the scope is `COLLECTION`: the Firebase CLI's validator checks `queryScope` only when
  // it is present and its own exports always write it, so an omission is a hand-written file, and
  // the CLI supplies this default for a composite index in the same position. A present value is
  // still held to a string.
  const queryScope =
    raw['queryScope'] === undefined
      ? 'COLLECTION'
      : requireString(raw['queryScope'], `${path}: "queryScope"`);
  validateConfig(raw, path);
  return { ...raw, queryScope } as SingleFieldIndex;
}

/**
 * The one-of check a composite index's field and a single-field index share: exactly one of
 * `order`, `arrayConfig`, and `vectorConfig`, each of the right type.
 */
function validateConfig(raw: Record<string, unknown>, path: string): void {
  const configured = (['order', 'arrayConfig', 'vectorConfig'] as const).filter(
    (name) => raw[name] !== undefined,
  );
  if (configured.length === 0) {
    throw new MalformedInputError(
      `${path}: needs one of "order", "arrayConfig", or "vectorConfig"`,
    );
  }
  if (configured.length > 1) {
    throw new MalformedInputError(
      `${path}: declares ${configured.map((name) => `"${name}"`).join(' and ')}; only one is allowed`,
    );
  }

  // Values are not checked against an enumeration, so a direction added by a future Firebase
  // release passes through instead of failing the run (SPEC §4).
  if (raw['order'] !== undefined) requireString(raw['order'], `${path}: "order"`);
  if (raw['arrayConfig'] !== undefined) requireString(raw['arrayConfig'], `${path}: "arrayConfig"`);
  if (raw['vectorConfig'] !== undefined && !isObject(raw['vectorConfig'])) {
    throw new MalformedInputError(`${path}: "vectorConfig" must be an object`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new MalformedInputError(
      value === undefined ? `${label} is missing` : `${label} must be a string`,
    );
  }
  if (value === '') {
    throw new MalformedInputError(`${label} must not be empty`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
