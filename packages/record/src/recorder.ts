/**
 * What the proxy saw: the distinct query shapes, and a count for every reason it declined one.
 *
 * Counts live here and not in the corpus. A count changes on every run without changing what must
 * be indexed, so it goes to stderr where it helps triage, and the file stays diff-stable (SPEC §7).
 */
import { gunzipSync, inflateSync } from 'node:zlib';
import {
  decodeJsonListen,
  decodeJsonRunAggregationQuery,
  decodeJsonRunQuery,
  forwardChannelMessages,
} from './decode-json.js';
import { decodeListen, decodeRunAggregationQuery, decodeRunQuery } from './decode.js';
import type { AggregationDecodeResult, DecodeResult } from './decode.js';
import { toAggregationShape, toQueryShape } from './shape.js';
import type { AggregationShape, QueryShape, SkipReason } from './types.js';
import { FrameSplitter, grpcMessages, WireError } from './wire.js';

/**
 * Ceiling on what a compressed message may expand to, matching the proxy's cap on an uncompressed
 * body. Without it the size limit applies only to the bytes on the wire, and a few kilobytes of
 * gzip expand to gigabytes before anything decides the message is too large.
 */
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;

/** Encodings this package can undo. Anything else is counted rather than guessed at. */
const DECOMPRESSORS = new Map<string, (input: Uint8Array) => Uint8Array>([
  ['gzip', (input) => gunzipSync(input, { maxOutputLength: MAX_DECOMPRESSED_BYTES })],
  ['deflate', (input) => inflateSync(input, { maxOutputLength: MAX_DECOMPRESSED_BYTES })],
]);

export class Recorder {
  readonly #shapes = new Map<string, QueryShape>();
  readonly #aggregations = new Map<string, AggregationShape>();
  readonly #skips = new Map<SkipReason, number>();
  #observed = 0;

  /** Distinct query shapes, in insertion order; `buildCorpus` is what sorts them. */
  get shapes(): QueryShape[] {
    return [...this.#shapes.values()];
  }

  /** Distinct aggregation shapes (issue #93), in insertion order; `buildCorpus` is what sorts them. */
  get aggregations(): AggregationShape[] {
    return [...this.#aggregations.values()];
  }

  get skips(): ReadonlyMap<SkipReason, number> {
    return this.#skips;
  }

  /**
   * Every query the proxy saw on a query-bearing RPC, recorded or not: `observed` is the recorded
   * count plus the sum of `skips`. A `Listen` message that carries no query — a `remove_target`,
   * a documents target — is neither, and does not move it.
   */
  get observed(): number {
    return this.#observed;
  }

  skip(reason: SkipReason): void {
    this.#observed += 1;
    this.#skips.set(reason, (this.#skips.get(reason) ?? 0) + 1);
  }

  /**
   * Record the `RunQuery` request in `body`.
   *
   * A body holds one message for a unary request, but the framing allows more and this counts each
   * one, so that a client that batches does not have every message after the first disappear.
   */
  recordRunQuery(body: Uint8Array, encoding: string): void {
    let messages;
    try {
      messages = [...grpcMessages(body)];
    } catch (error) {
      if (!(error instanceof WireError)) throw error;
      this.skip('undecodable-message');
      return;
    }

    // A query-bearing call that carried no message at all. Counted rather than passed over: a
    // RunQuery the proxy saw and recorded nothing for has to appear somewhere, or the corpus says
    // the query was never issued.
    if (messages.length === 0) {
      this.skip('undecodable-message');
      return;
    }

    for (const message of messages) this.#record(message, encoding, decodeRunQuery);
  }

  /**
   * Record the `RunAggregationQueryRequest` in `body` (issue #93).
   *
   * Same framing as `recordRunQuery`, over `RunAggregationQuery`'s own unary request: the RPC is
   * server-streaming on the response side only, so the request body is one gRPC-framed message the
   * same way a `RunQuery` request is.
   */
  recordRunAggregationQuery(body: Uint8Array, encoding: string): void {
    let messages;
    try {
      messages = [...grpcMessages(body)];
    } catch (error) {
      if (!(error instanceof WireError)) throw error;
      this.skip('undecodable-message');
      return;
    }
    if (messages.length === 0) {
      this.skip('undecodable-message');
      return;
    }
    for (const message of messages) this.#recordAggregation(message, encoding, decodeRunAggregationQuery);
  }

  /**
   * Record the targets of one `Listen` stream as its request bytes arrive.
   *
   * The stream is bidirectional and lives as long as the listener does, so nothing here waits for
   * it to end: each frame is decoded the moment it is complete, and a target re-sent after a
   * reconnect collapses onto the same key as any other repeat. An empty stream counts nothing —
   * unlike a `RunQuery`, a `Listen` with no message yet is a stream that has only just opened.
   */
  recordListen(encoding: string, maxFrameBytes: number): { push(chunk: Uint8Array): void; end(): void } {
    const splitter = new FrameSplitter(maxFrameBytes);
    // Once the framing is wrong there is no next frame boundary to find; everything after is bytes.
    let broken = false;
    const fault = (): void => {
      broken = true;
      this.skip('undecodable-message');
    };
    return {
      push: (chunk) => {
        if (broken) return;
        try {
          for (const frame of splitter.push(chunk)) {
            if ('tooLarge' in frame) this.skip('undecodable-message');
            else this.#record(frame, encoding, decodeListen);
          }
        } catch (error) {
          if (!(error instanceof WireError)) throw error;
          fault();
        }
      },
      end: () => {
        if (broken) return;
        try {
          splitter.end();
        } catch (error) {
          if (!(error instanceof WireError)) throw error;
          fault();
        }
      },
    };
  }

  /**
   * Record the `RunQueryRequest` a REST `documents:runQuery` request carries as JSON (issue #58).
   *
   * One request is one message: the REST form has no framing, so unlike the gRPC body there is no
   * second message to look for and nothing to split.
   */
  recordRestRunQuery(body: Uint8Array): void {
    this.#count(decodeJsonRunQuery(body));
  }

  /**
   * Record the `StructuredAggregationQuery` a REST `documents:runAggregationQuery` request carries
   * as JSON (issue #93). One request is one message, as `recordRestRunQuery` is.
   */
  recordRestRunAggregationQuery(body: Uint8Array): void {
    this.#countAggregation(decodeJsonRunAggregationQuery(body));
  }

  /**
   * Record the targets one WebChannel forward-channel POST carries (issue #58).
   *
   * A POST holds zero or more `ListenRequest`s, each read as `recordListen` reads a frame: a target
   * is a query whether the channel it rides on is ever answered. A POST that carries no message —
   * the channel's own handshake and teardown — counts nothing, like a `Listen` stream that has only
   * just opened.
   */
  recordForwardChannel(body: Uint8Array): void {
    let messages: string[];
    try {
      messages = forwardChannelMessages(body);
    } catch (error) {
      if (!(error instanceof WireError)) throw error;
      this.skip('undecodable-message');
      return;
    }
    for (const message of messages) this.#count(decodeJsonListen(message));
  }

  /**
   * Undo one framed message's compression, or skip and return `null`.
   *
   * Split out of `#record` so that `#recordAggregation` shares it rather than repeating the
   * decompress-or-skip decision the two RPCs make identically.
   */
  #decompress(message: { readonly compressed: boolean; readonly payload: Uint8Array }, encoding: string): Uint8Array | null {
    if (!message.compressed) return message.payload;
    const decompress = DECOMPRESSORS.get(encoding);
    if (decompress === undefined) {
      this.skip('unsupported-encoding');
      return null;
    }
    try {
      return decompress(message.payload);
    } catch {
      this.skip('undecodable-message');
      return null;
    }
  }

  /** One framed message: undo its compression, decode it, and count what came of that. */
  #record(
    message: { readonly compressed: boolean; readonly payload: Uint8Array },
    encoding: string,
    decode: (payload: Uint8Array) => DecodeResult | null,
  ): void {
    const payload = this.#decompress(message, encoding);
    if (payload === null) return;
    this.#count(decode(payload));
  }

  /** As `#record`, for the aggregation decoders. */
  #recordAggregation(
    message: { readonly compressed: boolean; readonly payload: Uint8Array },
    encoding: string,
    decode: (payload: Uint8Array) => AggregationDecodeResult,
  ): void {
    const payload = this.#decompress(message, encoding);
    if (payload === null) return;
    this.#countAggregation(decode(payload));
  }

  /** What one decoded message comes to: a shape, a skip, or — for control traffic — nothing. */
  #count(result: DecodeResult | null): void {
    if (result === null) return;
    if (!result.ok) {
      this.skip(result.reason);
      return;
    }
    this.#observed += 1;
    const shape = toQueryShape(result.query);
    this.#shapes.set(shape.key, shape);
  }

  /** As `#count`, for an aggregation decode result. There is no control-traffic case to admit `null`. */
  #countAggregation(result: AggregationDecodeResult): void {
    if (!result.ok) {
      this.skip(result.reason);
      return;
    }
    this.#observed += 1;
    const shape = toAggregationShape(result.query);
    this.#aggregations.set(shape.key, shape);
  }
}
