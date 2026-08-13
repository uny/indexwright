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
  return {
    collectionGroup: shape.collectionGroup,
    queryScope: shape.queryScope,
    where: planRoot(shape.where),
    orderBy: [...shape.orderBy],
  };
}
