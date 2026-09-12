/**
 * The corpus file: building it, writing it, and reading it back (SPEC §7, *File shape*).
 *
 * The reader refuses rather than repairs. Every reading it would otherwise be choosing between is
 * a different query, and picking one is how a corpus comes to describe coverage it never had.
 */
import { randomBytes } from 'node:crypto';
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
  Producer,
  QueryScope,
  QueryShape,
  SkipReason,
} from './types.js';
import {
  CORPUS_VERSION,
  FIELD_OPERATORS,
  isComposite,
  READABLE_CORPUS_VERSIONS,
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
 * How deep a filter tree in a corpus file may nest before the reader refuses it.
 *
 * The same ceiling the decoder applies, so nothing this package writes can fail to read back. The
 * reader recurses once per level, and a corpus is a committed file that arrives through review
 * rather than from a trusted caller: without a ceiling, a nested-enough file is a `RangeError`
 * escaping a function documented to fail with `CorpusError`.
 */
const MAX_FILTER_DEPTH = 100;

/**
 * Collect observed shapes into a corpus: de-duplicated by key, sorted by key, with the skip
 * reasons as a sorted set. Occurrence counts do not survive this — they go to stderr (SPEC §7).
 */
export function buildCorpus(
  shapes: Iterable<QueryShape>,
  skipped: Iterable<SkipReason>,
  producers: Iterable<Producer> = [],
): Corpus {
  const byKey = new Map<string, QueryShape>();
  for (const shape of shapes) byKey.set(shape.key, shape);
  const queries = [...byKey.values()].sort((a, b) => compareByCodePoint(a.key, b.key));
  const reasons = [...new Set(skipped)].sort((a, b) => compareByCodePoint(a, b));
  return { corpusVersion: CORPUS_VERSION, producers: sortProducers(producers), queries, skipped: reasons };
}

/**
 * Producers as a sorted set, on the pair rather than on the name.
 *
 * Two revisions of one producer are two things a reviewer has reason to see — a merge (§7) of a
 * current corpus and a stale one from the same suite is exactly the case the identity exists to
 * make visible, and de-duplicating on the name alone would collapse it back into one line.
 */
function sortProducers(producers: Iterable<Producer>): Producer[] {
  const byPair = new Map<string, Producer>();
  for (const producer of producers) {
    // Refused here for the same reason the filter depth is bounded where it is written: nothing
    // this package writes may fail to read back. The CLI has already refused an empty value, but
    // the JS API reaches this directly, and a corpus its own reader declines is not one. So the
    // checks are the reader's, member for member: an absent revision arrives as `undefined` from
    // an untyped caller, and `JSON.stringify` drops the member rather than writing `null`.
    if (typeof producer.name !== 'string') throw new CorpusError('a producer name is not a string');
    if (producer.name === '') throw new CorpusError('a producer name is empty');
    if (producer.revision !== null && typeof producer.revision !== 'string') {
      throw new CorpusError('a producer revision is not a string or null');
    }
    if (producer.revision === '') throw new CorpusError('a producer revision is empty; an unnamed revision is null');
    // Keyed as a tuple rather than by joining the pair on a separator. A separator has to be a
    // character neither member may hold, and `Producer` reserves none: a name ending in it and a
    // revision beginning with it key the same, and one of two distinct identities is dropped
    // without a word — the silent loss this member exists to make impossible.
    byPair.set(JSON.stringify([producer.name, producer.revision]), {
      name: producer.name,
      revision: producer.revision,
    });
  }
  // The same order the reader holds a file to, so that what this writes is what that accepts.
  return [...byPair.values()].sort(compareProducers);
}

/**
 * Merge several corpora into one (SPEC §7, *Merging*).
 *
 * One index set is routinely consumed by more than one suite, and each suite's corpus is a partial
 * view of what queries the set. Checking them one at a time answers a narrower question than the set
 * poses, because a set can satisfy every corpus checked while failing the one that was not.
 *
 * Every rule here is §7's own rather than this function's: `queries` de-duplicate on the canonical
 * key and sort by it, `skipped` is a set of reasons, `producers` is a set on the (name, revision)
 * pair, and `corpusVersion` names the format the parts must agree on. That the rules were already
 * written down is the argument for this being a function rather than a `jq` every adopter writes —
 * and the ones who write it slightly wrong get a corpus that reads as broader than it is.
 *
 * The result is a corpus in the sense §7 defines: readable by anything that reads one. It is not
 * promoted to `CORPUS_VERSION`; it stays at the version its parts agreed on, for the reason a read
 * of a version-1 corpus serialises back to version 1.
 */
export function mergeCorpora(parts: readonly Corpus[]): Corpus {
  // Refused rather than answered with an empty corpus. An empty corpus replays cleanly by
  // construction — it is the false clean verdict `check` refuses a single empty corpus for — and a
  // merge that invented one out of no parts would be a route around that refusal.
  if (parts.length === 0) throw new CorpusError('a merge needs at least one corpus');

  const version = (parts[0] as Corpus).corpusVersion;
  for (const part of parts) {
    // Refused rather than merged across, and refused before anything is combined. The integer names
    // the format both sides have to agree on, so a merge across two of them would be producing a
    // file under a version that describes only half of what went into it.
    if (part.corpusVersion !== version) {
      throw new CorpusError(
        `cannot merge corpora at different versions: corpusVersion ${version} and ${part.corpusVersion}`,
      );
    }
  }

  const byKey = new Map<string, QueryShape>();
  for (const part of parts) {
    for (const query of part.queries) {
      const existing = byKey.get(query.key);
      // The key is injective over the shape, so two parts that observed the same query agree on
      // every other member. Disagreeing means a part has been edited or has arrived corrupted, and
      // taking either side silently — which is what the last-writer-wins of `buildCorpus` would do —
      // is how a merged corpus comes to describe a query neither part recorded.
      if (existing !== undefined) {
        if (JSON.stringify(queryToJson(existing)) !== JSON.stringify(queryToJson(query))) {
          throw new CorpusError(
            `two corpora hold the key ${JSON.stringify(query.key)} with bodies that differ; one of them is not the shape its key names`,
          );
        }
        continue;
      }
      byKey.set(query.key, query);
    }
  }

  return {
    corpusVersion: version,
    producers: sortProducers(parts.flatMap((part) => [...part.producers])),
    queries: [...byKey.values()].sort((a, b) => compareByCodePoint(a.key, b.key)),
    skipped: [...new Set(parts.flatMap((part) => [...part.skipped]))].sort(compareByCodePoint),
  };
}

/**
 * Serialise with every member present and in the documented order.
 *
 * Built explicitly rather than handed to `JSON.stringify` as-is: the order of the members is part
 * of what makes two recorders that saw the same queries write the same bytes.
 */
export function serialiseCorpus(corpus: Corpus): string {
  // Checked rather than dereferenced. An untyped caller carried over from before this format
  // version builds the corpus object itself and names no `producers` — which reached `.map` below
  // as a bare `TypeError` naming neither the member nor the version that added it.
  if (!Array.isArray(corpus.producers)) {
    throw new CorpusError('the corpus has no producers member; a corpus naming no producer has an empty one');
  }
  // A corpus at version 1 has no member to write the producers into, so writing it as one would
  // drop them — silently, which is what `--revision` without `--producer` is refused to avoid.
  // Refused rather than promoted to version 2: a corpus read at 1 serialises back to 1, and
  // rewriting the version here would change a file the caller only meant to add to.
  if (corpus.corpusVersion < 2 && corpus.producers.length > 0) {
    throw new CorpusError(
      `a corpus at version ${corpus.corpusVersion} has no producers member, but this one names ${corpus.producers.length}`,
    );
  }

  const value = {
    corpusVersion: corpus.corpusVersion,
    // Omitted at version 1, which has no such member: this package still reads that version, and a
    // corpus read at 1 has to serialise back to the bytes it was read from. Near the top rather
    // than after `queries`, so that the first thing a review of a regenerated corpus sees is who
    // says it is theirs.
    ...(corpus.corpusVersion >= 2 ? { producers: corpus.producers.map(producerToJson) } : {}),
    queries: corpus.queries.map(queryToJson),
    skipped: [...corpus.skipped],
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * One entry in the documented member order.
 *
 * Named rather than inlined because `mergeCorpora` compares two entries sharing a key through it:
 * the comparison has to be over every member the file carries, and deriving it from the same
 * function that writes the file is what keeps it that way when a member is added.
 */
function queryToJson(query: QueryShape): unknown {
  return {
    key: query.key,
    collectionGroup: query.collectionGroup,
    queryScope: query.queryScope,
    where: filterToJson(query.where),
    orderBy: query.orderBy.map((order) => ({ fieldPath: order.fieldPath, direction: order.direction })),
  };
}

function producerToJson(producer: Producer): unknown {
  return { name: producer.name, revision: producer.revision };
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
 *
 * The temporary name is random rather than derived from the pid, and is created exclusively: the
 * corpus is often written into a shared workspace, and a predictable name is one another user can
 * pre-create as a symlink to have this write land somewhere else entirely.
 */
export function writeCorpus(path: string, corpus: Corpus): void {
  const temporary = join(dirname(path), `.${randomBytes(8).toString('hex')}.indexwright-corpus.tmp`);
  try {
    writeFileSync(temporary, serialiseCorpus(corpus), { encoding: 'utf8', mode: 0o644, flag: 'wx' });
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

  // Checked before the member set, not after: adding or renaming a top-level member is the normal
  // reason to bump the version, so testing membership first would answer a future corpus with a
  // complaint about a stray field instead of the version mismatch that explains it.
  const version = root['corpusVersion'];
  if (typeof version !== 'number' || !READABLE_CORPUS_VERSIONS.includes(version)) {
    // Not a fallback to what this version recognises: the integer exists to announce exactly the
    // change that reading on regardless would mis-read. The versions listed are the ones whose
    // shape is written down here, not the ones whose members happen to overlap.
    throw new CorpusError(
      `corpusVersion ${describeVersion(version)} is not readable by this version, which writes ${CORPUS_VERSION}`,
    );
  }

  // Version-dependent, and checked after the version for the reason above: the member set *is* what
  // the version names, so one list for both would refuse a corpus of the other version by
  // complaining about the member that distinguishes them.
  expectExactMembers(
    root,
    version >= 2 ? ['corpusVersion', 'producers', 'queries', 'skipped'] : ['corpusVersion', 'queries', 'skipped'],
    'the corpus',
  );

  // A version-1 corpus names no producer. Read as `[]` rather than refused: that is what the member
  // being optional means, and it is the reading `check --require-identity` then acts on.
  const producers = version >= 2 ? parseProducers(root['producers']) : [];

  const queries = expectArray(root['queries'], 'queries').map((entry, index) =>
    parseQuery(entry, `queries[${index}]`),
  );

  // Sorted, not merely unique. The file is diff-stable only because there is one order for a given
  // set of entries, and a reader that accepted any order would round-trip a corpus to different
  // bytes than the one it read — the property SPEC §7 has the sort for.
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const query of queries) {
    if (seen.has(query.key)) throw new CorpusError(`two entries share the key ${JSON.stringify(query.key)}`);
    if (previous !== null && compareByCodePoint(previous, query.key) > 0) {
      throw new CorpusError(`queries are not sorted by key: ${JSON.stringify(query.key)} follows ${JSON.stringify(previous)}`);
    }
    seen.add(query.key);
    previous = query.key;
  }

  const skipped = expectArray(root['skipped'], 'skipped').map((reason, index) => {
    if (typeof reason !== 'string' || !SKIP_REASON_SET.has(reason)) {
      throw new CorpusError(`skipped[${index}] is not a reason this format defines`);
    }
    return reason as SkipReason;
  });
  if (new Set(skipped).size !== skipped.length) throw new CorpusError('skipped repeats a reason');
  for (let index = 1; index < skipped.length; index += 1) {
    if (compareByCodePoint(skipped[index - 1] as string, skipped[index] as string) > 0) {
      throw new CorpusError('skipped is not sorted');
    }
  }

  return { corpusVersion: version, producers, queries, skipped };
}

/**
 * The producers, sorted and de-duplicated as written, or a refusal.
 *
 * Held to the same standard as `queries` and `skipped`: a set in one order. A reader that took any
 * order would round-trip a corpus to different bytes than the ones it read, and §7 asks the file be
 * diff-stable so that its diffs stay worth reading.
 */
function parseProducers(value: unknown): Producer[] {
  const producers = expectArray(value, 'producers').map((entry, index) => {
    const at = `producers[${index}]`;
    const object = expectObject(entry, at);
    expectExactMembers(object, ['name', 'revision'], at);
    const name = expectString(object['name'], `${at}.name`);
    // Empty is refused rather than read as absent. A producer that names nothing identifies nothing,
    // and the way to say "no producer" is to have no entry.
    if (name === '') throw new CorpusError(`${at}.name is empty`);
    const raw = object['revision'];
    if (raw !== null && typeof raw !== 'string') {
      throw new CorpusError(`${at}.revision is not a string or null`);
    }
    if (raw === '') throw new CorpusError(`${at}.revision is empty; an unnamed revision is null`);
    return { name, revision: raw };
  });

  let previous: Producer | null = null;
  for (const producer of producers) {
    if (previous !== null) {
      const order = compareProducers(previous, producer);
      // Named by the pair, because the order is on the pair: two revisions of one producer out of
      // order would otherwise refuse with the same name on both sides of "follows".
      if (order > 0) {
        throw new CorpusError(`producers are not sorted: ${describePair(producer)} follows ${describePair(previous)}`);
      }
      if (order === 0) throw new CorpusError(`producers repeats ${describePair(producer)}`);
    }
    previous = producer;
  }
  return producers;
}

/** One producer as a refusal names it: the pair, since the pair is what the order and the set are on. */
function describePair(producer: Producer): string {
  return producer.revision === null
    ? `${JSON.stringify(producer.name)} at no revision`
    : `${JSON.stringify(producer.name)} at ${JSON.stringify(producer.revision)}`;
}

/**
 * Name first, then revision, with an absent revision before any present one.
 *
 * Absent is not `''` — the reader refuses an empty revision — so it is ordered rather than
 * compared: a producer that named no revision sorts before the same producer that named one.
 */
function compareProducers(a: Producer, b: Producer): number {
  const byName = compareByCodePoint(a.name, b.name);
  if (byName !== 0) return byName;
  if (a.revision === b.revision) return 0;
  if (a.revision === null) return -1;
  if (b.revision === null) return 1;
  return compareByCodePoint(a.revision, b.revision);
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

  const where = parseFilter(entry['where'], `${at}.where`, 1);
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

function parseFilter(value: unknown, at: string, depth: number): FilterNode {
  if (depth > MAX_FILTER_DEPTH) throw new CorpusError(`${at} nests deeper than this reader descends`);
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
      parseFilter(child, `${at}.filters[${index}]`, depth + 1),
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

/**
 * A version value as one phrase, for the message that refuses it.
 *
 * An array or an object is *named* rather than serialised. `JSON.parse` and `JSON.stringify` do not
 * have the same recursion budget, and `stringify`'s frames are the heavier, so a file whose version
 * is a deep enough nested array parses and then overflows on the way to being refused — a
 * `RangeError` escaping a function documented to fail with `CorpusError`, which is the same failure
 * `MAX_FILTER_DEPTH` exists to close, arriving through the message instead of the tree.
 *
 * Bounded by construction rather than by catching the overflow: a caught `RangeError` is a guess
 * about how much stack was left when the value arrived, and the depth at which it happens is a
 * property of the runtime rather than of the file. Nothing here walks the value at all.
 *
 * Everything else is serialised, at whatever length the file gave it — what is bounded above is the
 * depth, not the size. A primitive is not recursive to serialise, so the message names the value
 * rather than a stand-in for it, and a missing member still reads `undefined` — `JSON.stringify`
 * returns no string for that one. The value, though, and not the file's spelling of it: `1e2` is
 * named `100` and `"\u0032"` is named `"2"`, and a magnitude no double holds — `1e400`, which parses
 * to `Infinity` — is named `null`, which is the only spelling JSON has for it.
 *
 * The two names are ASCII, like every other message this reader writes: `check` renders the whole of
 * it before it reaches the stream, so an ellipsis would have arrived as `\u2026` — and a non-ASCII
 * primitive is escaped by that pass rather than by this one.
 */
function describeVersion(value: unknown): string {
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? '[...]' : '{...}';
  return JSON.stringify(value) ?? String(value);
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
