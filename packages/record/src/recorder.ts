/**
 * What the proxy saw: the distinct query shapes, and a count for every reason it declined one.
 *
 * Counts live here and not in the corpus. A count changes on every run without changing what must
 * be indexed, so it goes to stderr where it helps triage, and the file stays diff-stable (SPEC §7).
 */
import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeRunQuery } from './decode.js';
import { toQueryShape } from './shape.js';
import type { QueryShape, SkipReason } from './types.js';
import { grpcMessages, WireError } from './wire.js';

/** Encodings this package can undo. Anything else is counted rather than guessed at. */
const DECOMPRESSORS = new Map<string, (input: Uint8Array) => Uint8Array>([
  ['gzip', (input) => gunzipSync(input)],
  ['deflate', (input) => inflateSync(input)],
]);

export class Recorder {
  readonly #shapes = new Map<string, QueryShape>();
  readonly #skips = new Map<SkipReason, number>();
  #observed = 0;
  #http1 = 0;

  /** Distinct query shapes, in insertion order; `buildCorpus` is what sorts them. */
  get shapes(): QueryShape[] {
    return [...this.#shapes.values()];
  }

  get skips(): ReadonlyMap<SkipReason, number> {
    return this.#skips;
  }

  /** Every request the proxy saw on a query-bearing RPC, recorded or not. */
  get observed(): number {
    return this.#observed;
  }

  /** Requests that arrived over HTTP/1.1, which carries no gRPC and is therefore never captured. */
  get http1(): number {
    return this.#http1;
  }

  skip(reason: SkipReason): void {
    this.#observed += 1;
    this.#skips.set(reason, (this.#skips.get(reason) ?? 0) + 1);
  }

  countHttp1(): void {
    this.#http1 += 1;
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

    for (const message of messages) {
      let payload = message.payload;
      if (message.compressed) {
        const decompress = DECOMPRESSORS.get(encoding);
        if (decompress === undefined) {
          this.skip('unsupported-encoding');
          continue;
        }
        try {
          payload = decompress(payload);
        } catch {
          this.skip('undecodable-message');
          continue;
        }
      }

      const result = decodeRunQuery(payload);
      if (!result.ok) {
        this.skip(result.reason);
        continue;
      }
      this.#observed += 1;
      const shape = toQueryShape(result.query);
      this.#shapes.set(shape.key, shape);
    }
  }
}
