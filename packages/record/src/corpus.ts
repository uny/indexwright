/**
 * The corpus file: building it, writing it, and reading it back (SPEC §7, *File shape*).
 *
 * The reader refuses rather than repairs. Every reading it would otherwise be choosing between is
 * a different query, and picking one is how a corpus comes to describe coverage it never had.
 */
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normaliseRoot, queryKey, serialiseFilter, compareByCodePoint } from './shape.js';
import type {
  Corpus,
  Direction,
  FilterComposite,
  FilterNode,
  FilterOperator,
  Order,
  QueryScope,
  QueryShape,
  SkipReason,
} from './types.js';
import {
  CORPUS_VERSION,
  FIELD_OPERATORS,
  isComposite,
  SKIP_REASONS,
  UNARY_OPERATORS,
} from './types.js';

/** A corpus that cannot be read as one. Never a repair, always a refusal. */
export class CorpusError extends Error {
  override readonly name = 'CorpusError';
}

const LEAF_OPERATORS = new Set<string>([...FIELD_OPERATORS, ...UNARY_OPERATORS]);
const SKIP_REASON_SET = new Set<string>(SKIP_REASONS);

/**
 * Collect observed shapes into a corpus: de-duplicated by key, sorted by key, with the skip
 * reasons as a sorted set. Occurrence counts do not survive this — they go to stderr (SPEC §7).
 */
export function buildCorpus(shapes: Iterable<QueryShape>, skipped: Iterable<SkipReason>): Corpus {
  const byKey = new Map<string, QueryShape>();
  for (const shape of shapes) byKey.set(shape.key, shape);
  const queries = [...byKey.values()].sort((a, b) => compareByCodePoint(a.key, b.key));
  const reasons = [...new Set(skipped)].sort((a, b) => compareByCodePoint(a, b));
  return { corpusVersion: CORPUS_VERSION, queries, skipped: reasons };
}

/**
 * Serialise with every member present and in the documented order.
 *
 * Built explicitly rather than handed to `JSON.stringify` as-is: the order of the members is part
 * of what makes two recorders that saw the same queries write the same bytes.
 */
export function serialiseCorpus(corpus: Corpus): string {
  const value = {
    corpusVersion: corpus.corpusVersion,
    queries: corpus.queries.map((query) => ({
      key: query.key,
      collectionGroup: query.collectionGroup,
      queryScope: query.queryScope,
      where: filterToJson(query.where),
      orderBy: query.orderBy.map((order) => ({
        fieldPath: order.fieldPath,
        direction: order.direction,
      })),
    })),
    skipped: [...corpus.skipped],
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

function filterToJson(node: FilterNode): unknown {
  if (isComposite(node)) return { op: node.op, filters: node.filters.map(filterToJson) };
  return { fieldPath: node.fieldPath, op: node.op };
}

/**
 * Write the corpus whole, and atomically.
 *
 * A run that is interrupted leaves the previous file intact rather than a truncated one, which
 * matters because the previous file is the only record of what the last complete run exercised.
 */
export function writeCorpus(path: string, corpus: Corpus): void {
  const temporary = join(dirname(path), `.${process.pid}.indexwright-corpus.tmp`);
  try {
    writeFileSync(temporary, serialiseCorpus(corpus), { encoding: 'utf8', mode: 0o644 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The write is the failure worth reporting; a leftover temp file is not.
    }
    throw error;
  }
}

export function parseCorpus(source: string): Corpus {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new CorpusError(`not valid JSON: ${(error as Error).message}`);
  }

  const root = expectObject(document, 'the corpus');
  expectExactMembers(root, ['corpusVersion', 'queries', 'skipped'], 'the corpus');

  const version = root['corpusVersion'];
  if (version !== CORPUS_VERSION) {
    // Not a fallback to what this version recognises: the integer exists to announce exactly the
    // change that reading on regardless would mis-read.
    throw new CorpusError(
      `corpusVersion ${JSON.stringify(version)} is not readable by this version, which writes ${CORPUS_VERSION}`,
    );
  }

  const queries = expectArray(root['queries'], 'queries').map((entry, index) =>
    parseQuery(entry, `queries[${index}]`),
  );

  const seen = new Set<string>();
  for (const query of queries) {
    if (seen.has(query.key)) throw new CorpusError(`two entries share the key ${JSON.stringify(query.key)}`);
    seen.add(query.key);
  }

  const skipped = expectArray(root['skipped'], 'skipped').map((reason, index) => {
    if (typeof reason !== 'string' || !SKIP_REASON_SET.has(reason)) {
      throw new CorpusError(`skipped[${index}] is not a reason this format defines`);
    }
    return reason as SkipReason;
  });
  if (new Set(skipped).size !== skipped.length) throw new CorpusError('skipped repeats a reason');

  return { corpusVersion: CORPUS_VERSION, queries, skipped };
}

function parseQuery(value: unknown, at: string): QueryShape {
  const entry = expectObject(value, at);
  expectExactMembers(entry, ['key', 'collectionGroup', 'queryScope', 'where', 'orderBy'], at);

  const key = expectString(entry['key'], `${at}.key`);
  const collectionGroup = expectString(entry['collectionGroup'], `${at}.collectionGroup`);
  const queryScope = entry['queryScope'];
  if (queryScope !== 'COLLECTION' && queryScope !== 'COLLECTION_GROUP') {
    throw new CorpusError(`${at}.queryScope is not a scope this format defines`);
  }

  const where = parseFilter(entry['where'], `${at}.where`);
  if (!isComposite(where)) throw new CorpusError(`${at}.where is not a composite`);

  const orderBy = expectArray(entry['orderBy'], `${at}.orderBy`).map((order, index) =>
    parseOrder(order, `${at}.orderBy[${index}]`),
  );

  const shape = { collectionGroup, queryScope: queryScope as QueryScope, where, orderBy };

  // The stored tree is the normalised one the key was computed from. A tree that normalises to
  // something else was not written by a conforming recorder, and repairing it here would let the
  // entry that happened to win de-duplication decide the file.
  if (serialiseFilter(normaliseRoot(where)) !== serialiseFilter(where)) {
    throw new CorpusError(`${at}.where is not in normalised form`);
  }
  const derived = queryKey(shape);
  if (derived !== key) {
    throw new CorpusError(`${at}.key does not describe its own query; expected ${JSON.stringify(derived)}`);
  }

  return { key, ...shape };
}

function parseFilter(value: unknown, at: string): FilterNode {
  const node = expectObject(value, at);
  const hasFilters = 'filters' in node;
  const hasFieldPath = 'fieldPath' in node;
  if (hasFilters && hasFieldPath) throw new CorpusError(`${at} is both a composite and a leaf`);
  if (!hasFilters && !hasFieldPath) throw new CorpusError(`${at} is neither a composite nor a leaf`);

  if (hasFilters) {
    expectExactMembers(node, ['op', 'filters'], at);
    const op = node['op'];
    if (op !== 'AND' && op !== 'OR') {
      throw new CorpusError(`${at}.op is not a composite operator this format defines`);
    }
    const filters = expectArray(node['filters'], `${at}.filters`).map((child, index) =>
      parseFilter(child, `${at}.filters[${index}]`),
    );
    return { op, filters } satisfies FilterComposite;
  }

  expectExactMembers(node, ['fieldPath', 'op'], at);
  const fieldPath = expectString(node['fieldPath'], `${at}.fieldPath`);
  const op = node['op'];
  if (typeof op !== 'string' || !LEAF_OPERATORS.has(op)) {
    throw new CorpusError(`${at}.op is not an operator this format defines`);
  }
  return { fieldPath, op: op as FilterOperator };
}

function parseOrder(value: unknown, at: string): Order {
  const order = expectObject(value, at);
  expectExactMembers(order, ['fieldPath', 'direction'], at);
  const fieldPath = expectString(order['fieldPath'], `${at}.fieldPath`);
  const direction = order['direction'];
  if (direction !== 'ASCENDING' && direction !== 'DESCENDING') {
    throw new CorpusError(`${at}.direction is not a direction this format defines`);
  }
  return { fieldPath, direction: direction as Direction };
}

function expectObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CorpusError(`${at} is not an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new CorpusError(`${at} is not an array`);
  return value;
}

function expectString(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new CorpusError(`${at} is not a string`);
  return value;
}

/**
 * Every member present, and no member the format does not define.
 *
 * Ignoring an unknown member is what a lenient reader does; here it would mean reading a corpus
 * written against a format this version cannot see, while reporting that it read it.
 */
function expectExactMembers(node: Record<string, unknown>, expected: readonly string[], at: string): void {
  for (const member of expected) {
    if (!(member in node)) throw new CorpusError(`${at} is missing ${member}`);
  }
  for (const member of Object.keys(node)) {
    if (!expected.includes(member)) {
      throw new CorpusError(`${at} carries ${JSON.stringify(member)}, which this format does not define`);
    }
  }
}
