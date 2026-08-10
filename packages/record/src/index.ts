/**
 * The JavaScript API.
 *
 * Provisional before 1.0, as `indexwright`'s is (SPEC §10). The corpus *format* is the contract
 * here — `corpusVersion` names it — and these functions are one way to produce and read it.
 */

export { buildCorpus, CorpusError, parseCorpus, serialiseCorpus, writeCorpus } from './corpus.js';
export { decodeRunQuery, type DecodeResult } from './decode.js';
export { classify, parseHostPort, startCapture, type Capture, type CaptureOptions, type Intent } from './proxy.js';
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
