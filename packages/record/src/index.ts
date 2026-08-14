/**
 * The JavaScript API.
 *
 * Provisional before 1.0, as `indexwright`'s is (SPEC §10). The corpus *format* is the contract
 * here — `corpusVersion` names it — and these functions are one way to produce and read it.
 */

export { buildCorpus, CorpusError, parseCorpus, serialiseCorpus, writeCorpus } from './corpus.js';
export { decodeRunQuery, type DecodeResult } from './decode.js';
export {
  classifyHost,
  EndpointError,
  isLoopbackHost,
  requireLoopbackBind,
  requireLoopbackUpstream,
  unbracketHost,
  type EndpointCheck,
  type HostClass,
  type HostOrigin,
} from './endpoints.js';
export { classify, parseHostPort, startCapture, type Capture, type CaptureOptions, type Intent } from './proxy.js';
export {
  DEFAULT_SETTLE_MS,
  INDEX_STATES,
  isReportable,
  isTransient,
  ReadinessGate,
  type IndexState,
  type LiveIndex,
  type Readiness,
} from './readiness.js';
export {
  INCOMPARABLE_REASONS,
  isVouched,
  reconcile,
  UNREADABLE_REASONS,
  type ExtraIndex,
  type IncomparableIndex,
  type IncomparableReason,
  type LiveCompositeIndex,
  type MatchedIndex,
  type Reconciliation,
  type ReconciliationVerdict,
  type UnreadableIndex,
  type UnreadableReason,
} from './reconcile.js';
export { Recorder } from './recorder.js';
export {
  compareByCodePoint,
  escapeComponent,
  normaliseFilter,
  normaliseRoot,
  queryKey,
  serialiseFilter,
  serialiseOrderBy,
  toQueryShape,
} from './shape.js';
export {
  isReplayComposite,
  NAME_FIELD,
  operandFor,
  planReplay,
  ReplayError,
  type Operand,
  type OperandType,
  type ReplayComposite,
  type ReplayLeaf,
  type ReplayNode,
  type ReplayPlan,
} from './synthesise.js';
export {
  CORPUS_VERSION,
  FIELD_OPERATORS,
  isComposite,
  SKIP_REASONS,
  UNARY_OPERATORS,
  type CompositeOperator,
  type Corpus,
  type Direction,
  type FieldOperator,
  type FilterComposite,
  type FilterLeaf,
  type FilterNode,
  type FilterOperator,
  type Order,
  type QueryScope,
  type QueryShape,
  type RawQuery,
  type SkipReason,
  type UnaryOperator,
} from './types.js';
export { VERSION } from './version.js';
export { fields, grpcMessages, WireError } from './wire.js';
