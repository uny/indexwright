import type { CompositeIndex, IndexDocument, IndexField } from './types.js';

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
  return { ...raw, indexes: validated } as IndexDocument;
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

  return { ...raw, fieldPath } as IndexField;
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
