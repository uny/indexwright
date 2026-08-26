/**
 * Turning a corpus entry back into a query that can be executed (SPEC §7, *Replay without values*).
 *
 * A corpus holds no values, so replay has to invent them. This module decides *what kind* of operand
 * each filter needs and nothing more: it builds no Firestore objects and imports no client. The
 * choice is structural — it follows from the operator and the field path, never from a value — so it
 * is decidable, and testable, without a database. Materialising the plan against a real collection
 * is the adapter's job.
 *
 * The split matters beyond tidiness. SPEC §7 requires that v0.3 report `FAILED_PRECONDITION` and
 * never `INVALID_ARGUMENT`, and the two synthesis mistakes that produce an `INVALID_ARGUMENT` — an
 * operand of the wrong shape, and an empty `where` — are both settled here, where they can be tested
 * exhaustively rather than observed one round-trip at a time.
 *
 * What this module does *not* decide is whether the recorded query was valid to begin with. A corpus
 * names operators and field paths, never values, so a combination the wire would refuse — `IN`
 * beside `NOT_IN`, an `IN` whose captured list was empty — is indistinguishable here from one it
 * would accept. Those are properties of the corpus vocabulary rather than of the plan, and the
 * verdict for them belongs to whatever executes the plan.
 */
import { render } from './args.js';
import type {
  CompositeOperator,
  FilterComposite,
  FilterNode,
  FilterOperator,
  Order,
  QueryScope,
  QueryShape,
} from './types.js';
import { isComposite, UNARY_OPERATORS } from './types.js';

/**
 * A corpus entry that cannot be replayed as a query at all.
 *
 * Thrown rather than papered over, the way `CorpusError` is: every repair available here replays a
 * *different* query than the one recorded, and a verdict about a query the suite never issued is
 * the failure §2 forbids wearing the costume of a result.
 */
export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

/**
 * The document key's field path.
 *
 * Spelled here rather than imported from `indexwright`: a filter on the document key needs a
 * reference operand, which is a §7 replay concern and carries none of the index model that `check`
 * takes the dependency for. The linter states the same constant as `NAME_FIELD` in `src/key.ts`.
 */
export const NAME_FIELD = '__name__';

/**
 * The segments of a wire field path, or a `ReplayError`.
 *
 * Decided here rather than at materialisation, and that is the whole of the fix: the rule is a
 * property of the *string the corpus recorded*, so it needs no client, and settling it during
 * planning is what puts an unreplayable entry on the near side of the settling minute along with
 * every other one. Left to `replayFieldPath`, it fired a `ReplayError` out of the middle of the
 * replay loop instead — a throw the verb has no route to the report for, so an entry it is
 * documented to *report* took the whole run down with an uncaught rejection.
 *
 * The corpus records the wire `field_path`, whose segments are joined with `.` and backtick-quoted
 * when a segment is not a plain name. The SDK's string form understands the dots and not the
 * backticks, so handing it a quoted path silently builds a filter on a *differently named field* —
 * which the candidate set does not cover, so the run reports a `FAILED_PRECONDITION` for a query
 * nobody issued. That is the false positive §2 forbids acting on, arriving as a confident finding,
 * so a path this version cannot convert is refused instead of approximated.
 *
 * Without a backtick the split is exact rather than a guess: a segment containing a `.` would have
 * had to be quoted, so an unquoted path has no segment that a split on `.` could tear in half.
 */
export function replaySegments(fieldPath: string): string[] {
  if (fieldPath.includes('`')) {
    throw new ReplayError(
      `the field path ${render(fieldPath)} is quoted, and this version cannot replay a quoted path`,
    );
  }
  const segments = fieldPath.split('.');
  if (segments.some((segment) => segment.length === 0)) {
    throw new ReplayError(`the field path ${render(fieldPath)} has an empty segment`);
  }
  return segments;
}

/**
 * A collection id that names one collection, or a `ReplayError`.
 *
 * A corpus is a committed artefact this machine did not necessarily author, and `parseCorpus` checks
 * only that `collectionGroup` is a string. A `/` in it is the one character that changes *which
 * collection is measured*: the SDK reads `users/u1/orders` as a path and hands back the subcollection
 * at it, so the run would replay against a collection the corpus never named and report the verdict
 * as though it were about the recorded one — a wrong answer with nothing about it that looks wrong.
 * An odd number of segments does not even get that far; it leaves the SDK as a plain `Error` from
 * inside the replay loop, which is the uncaught path `replaySegments` above exists to close.
 *
 * Empty is refused for the same reason `requirePath` refuses an empty path: it is not an id, and the
 * SDK's own message for it names an argument this package's caller never wrote.
 */
export function replayCollectionId(collectionGroup: string): string {
  if (collectionGroup.length === 0) {
    throw new ReplayError('the collection id is empty, and cannot be replayed');
  }
  if (collectionGroup.includes('/')) {
    throw new ReplayError(
      `the collection id ${render(collectionGroup)} contains a '/', and this version cannot replay ` +
        'a query against anything but a collection named by its id alone',
    );
  }
  return collectionGroup;
}

/** Operators that compare against a list rather than a single operand. */
const LIST_OPERATORS = new Set<FilterOperator>(['IN', 'NOT_IN', 'ARRAY_CONTAINS_ANY']);

/**
 * Derived from the vocabulary rather than restated beside it: a unary operator this set failed to
 * name would be planned as a scalar operand, which is the wrong-shaped operand this module exists
 * to settle, and restating the list is how the two lists come to disagree.
 */
const UNARY: ReadonlySet<FilterOperator> = new Set<FilterOperator>(UNARY_OPERATORS);

/**
 * What a filter compares against.
 *
 * `reference` is not a kind of scalar. Firestore validates a `__name__` operand against the document
 * key before it selects an index, so a string there fails with `INVALID_ARGUMENT` and never reaches
 * the question replay is asking.
 */
export type OperandType = 'scalar' | 'reference';

export type Operand =
  /** A unary filter carries no operand at all. */
  | { readonly arity: 'none' }
  | { readonly arity: 'single'; readonly type: OperandType }
  /** `IN`, `NOT_IN`, and `ARRAY_CONTAINS_ANY`: a one-element array. */
  | { readonly arity: 'array'; readonly type: OperandType };

export interface ReplayLeaf {
  readonly fieldPath: string;
  readonly op: FilterOperator;
  readonly operand: Operand;
}

export interface ReplayComposite {
  readonly op: CompositeOperator;
  readonly filters: readonly ReplayNode[];
}

export type ReplayNode = ReplayLeaf | ReplayComposite;

export interface ReplayPlan {
  readonly collectionGroup: string;
  readonly queryScope: QueryScope;
  /**
   * `null` means the query replays with `where` omitted altogether.
   *
   * Not an empty `AND`: a wire `CompositeFilter` must carry at least one filter, so an empty one is
   * an `INVALID_ARGUMENT` rather than a statement about the index set. Every composite reachable
   * from here therefore has at least one child — `planReplay` throws `ReplayError` rather than
   * return one that does not.
   */
  readonly where: ReplayComposite | null;
  readonly orderBy: readonly Order[];
}

export function isReplayComposite(node: ReplayNode): node is ReplayComposite {
  return 'filters' in node;
}

/**
 * Decide the operand for one leaf.
 *
 * Arity comes from the operator and type comes from the field path, and the two compose: a
 * `__name__ IN [...]` needs a one-element array *of references*, which neither rule states alone.
 */
export function operandFor(fieldPath: string, op: FilterOperator): Operand {
  if (UNARY.has(op)) return { arity: 'none' };
  const type: OperandType = fieldPath === NAME_FIELD ? 'reference' : 'scalar';
  // "Everything else" in SPEC §7 is a finite list rather than a default, because the vocabulary
  // encloses the operators a corpus may hold — anything outside it was skipped at capture as
  // `unsupported-shape` and cannot arrive here.
  if (LIST_OPERATORS.has(op)) return { arity: 'array', type };
  return { arity: 'single', type };
}

function planNode(node: FilterNode): ReplayNode {
  if (!isComposite(node)) {
    // `__name__` is exempt: it is the SDK's own reserved sentinel, reached through `documentId()`
    // rather than through a segment split, so the rule about segments has nothing to say about it.
    if (node.fieldPath !== NAME_FIELD) replaySegments(node.fieldPath);
    return { fieldPath: node.fieldPath, op: node.op, operand: operandFor(node.fieldPath, node.op) };
  }
  // Below the root, a childless composite is never the wrapper `normaliseRoot` manufactures — it is
  // a `CompositeFilter` the suite actually sent, which the wire requires to carry a filter. Nothing
  // can be sent for it and nothing may be dropped in its place: removing it would replay a strictly
  // wider query and report coverage for a shape that was never issued.
  if (node.filters.length === 0) {
    throw new ReplayError(`a nested ${node.op} filter with no children cannot be replayed`);
  }
  return { op: node.op, filters: node.filters.map(planNode) };
}

/**
 * The one childless composite that is exempt: the empty `AND`.
 *
 * `normaliseRoot` stores a query that carried no `where` at all as an empty `AND`, and replaying
 * that without a `where` replays the same query. An empty `OR` is not that: it is a filter that was
 * on the wire and matches nothing, so omitting it would issue an *unfiltered* query — which needs no
 * index, succeeds, and reports the entry covered when nothing was ever checked. A false clean
 * verdict is the outcome §2 forbids most strictly, so this refuses instead.
 *
 * The exemption is a choice under an ambiguity the format does not resolve, not a fact about the
 * entry: a `where` that normalises away to nothing is recorded identically to no `where` at all, so
 * this branch cannot tell an ordinary unfiltered query from one that was already `INVALID_ARGUMENT`
 * at capture. SPEC §7 carries the argument for taking the benign reading; it is not repeated here.
 */
function planRoot(where: FilterComposite): ReplayComposite | null {
  if (where.filters.length === 0) {
    if (where.op === 'AND') return null;
    throw new ReplayError('a root OR filter with no children cannot be replayed');
  }
  return planNode(where) as ReplayComposite;
}

/**
 * Plan the replay of one corpus entry.
 *
 * Sort order passes through untouched. SPEC §7, *Implicit fields are not materialised*: the corpus
 * records the orders as sent, and replay re-sends them as recorded — adding or removing a `__name__`
 * here would replay a query the suite never issued, and the oracle is Firestore rather than any rule
 * this package could apply.
 *
 * Throws `ReplayError` for an entry that has no replayable form at all, rather than returning a plan
 * for a query other than the one recorded.
 */
export function planReplay(shape: QueryShape): ReplayPlan {
  const orderBy = [...shape.orderBy];
  // Checked here so that every way an entry can turn out to have no replayable form arrives at the
  // caller as one `ReplayError`, before a client exists. `where` is walked by `planRoot`; these are
  // the two parts of a shape it does not reach.
  for (const order of orderBy) if (order.fieldPath !== NAME_FIELD) replaySegments(order.fieldPath);
  return {
    collectionGroup: replayCollectionId(shape.collectionGroup),
    queryScope: shape.queryScope,
    where: planRoot(shape.where),
    orderBy,
  };
}
