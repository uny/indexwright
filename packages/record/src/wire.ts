/**
 * A protobuf wire-format reader, in-tree and without a dependency.
 *
 * SPEC §7 fixes a closed operator vocabulary and requires anything outside it to be counted rather
 * than named, so the enum tables have to live here whichever library reads the bytes. What a
 * protobuf runtime would add on top of that is varint and length-delimited field parsing over a
 * handful of field numbers that a released `.proto` cannot renumber.
 *
 * Every failure is a `WireError`. The bytes come off a socket, so a reader that threw a
 * `RangeError` from somewhere inside itself would be indistinguishable from a bug in the caller.
 */
export class WireError extends Error {
  override readonly name = 'WireError';
}

export type WireField =
  | { readonly number: number; readonly kind: 'varint'; readonly value: bigint }
  | { readonly number: number; readonly kind: 'fixed64'; readonly value: bigint }
  | { readonly number: number; readonly kind: 'fixed32'; readonly value: number }
  | { readonly number: number; readonly kind: 'bytes'; readonly value: Uint8Array };

/** A varint is at most ten bytes; beyond that the input is not a varint however it was produced. */
const MAX_VARINT_BYTES = 10;

/**
 * Iterate the top-level fields of one encoded message.
 *
 * Unknown field numbers are yielded like any other: a caller reads the ones it knows and ignores
 * the rest, which is what lets a newer server add a field without this decoder rejecting the
 * message.
 */
export function* fields(bytes: Uint8Array): Generator<WireField> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (let read = 0; read < MAX_VARINT_BYTES; read += 1) {
      if (offset >= bytes.length) throw new WireError('varint runs past the end of the message');
      const byte = bytes[offset] as number;
      offset += 1;
      // A varint is 64 bits, so the tenth byte contributes bit 63 and nothing above it. Without
      // this the reader accepts values up to 2^70, which no encoder produces and which nothing
      // downstream can interpret as the number that was meant.
      if (read === MAX_VARINT_BYTES - 1 && (byte & 0x7f) > 1) {
        throw new WireError('varint does not fit in 64 bits');
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new WireError('varint is longer than ten bytes');
  };

  while (offset < bytes.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (number === 0) throw new WireError('field number 0 is not valid');

    switch (wireType) {
      case 0:
        yield { number, kind: 'varint', value: varint() };
        break;
      case 1: {
        if (offset + 8 > bytes.length) throw new WireError('fixed64 runs past the end');
        yield { number, kind: 'fixed64', value: view.getBigUint64(offset, true) };
        offset += 8;
        break;
      }
      case 2: {
        const length = Number(varint());
        if (!Number.isSafeInteger(length) || length < 0) throw new WireError('bad length prefix');
        if (offset + length > bytes.length) {
          throw new WireError('length-delimited field runs past the end');
        }
        yield { number, kind: 'bytes', value: bytes.subarray(offset, offset + length) };
        offset += length;
        break;
      }
      case 5: {
        if (offset + 4 > bytes.length) throw new WireError('fixed32 runs past the end');
        yield { number, kind: 'fixed32', value: view.getUint32(offset, true) };
        offset += 4;
        break;
      }
      default:
        // Groups (3 and 4) were removed from proto3 and Firestore does not use them; 6 and 7 have
        // never been assigned. None can be skipped without knowing its length.
        throw new WireError(`wire type ${wireType} is not supported`);
    }
  }
}

/** Read a length-delimited field as UTF-8, rejecting the malformed sequences `TextDecoder` hides. */
export function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WireError('field is not valid UTF-8');
  }
}

const TWO_TO_THE_64 = 1n << 64n;
const TWO_TO_THE_63 = 1n << 63n;

/**
 * Read a varint field as an enum value.
 *
 * Enums are `int32` on the wire, and a negative one is sign-extended to the full ten bytes. Read
 * as unsigned that is a huge number, and rejecting it would report a message that parsed perfectly
 * as `undecodable-message` — the one reason SPEC §7 reserves for having read the wire wrongly —
 * when what actually happened is an operator this vocabulary cannot name. Sign-extended values are
 * folded back to their negative selves; no table has a negative key, so they fall through to
 * `unsupported-shape` like any other unknown value.
 */
export function enumeration(value: bigint): number {
  const signed = value >= TWO_TO_THE_63 ? value - TWO_TO_THE_64 : value;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new WireError('varint is out of range');
  }
  return Number(signed);
}

/**
 * Split a gRPC request body into its length-prefixed messages.
 *
 * Each is a one-byte compressed flag, a four-byte big-endian length, and the payload. A body that
 * ends mid-message is an error rather than a shorter list: the caller counts what it could not
 * read, and silently returning the messages that did fit is how a dropped query starts looking
 * like a query that was never issued.
 */
export function* grpcMessages(body: Uint8Array): Generator<{ compressed: boolean; payload: Uint8Array }> {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 0;
  while (offset < body.length) {
    if (offset + 5 > body.length) throw new WireError('gRPC frame header is truncated');
    const flag = body[offset] as number;
    if (flag > 1) throw new WireError(`gRPC compressed flag ${flag} is not valid`);
    const length = view.getUint32(offset + 1, false);
    if (offset + 5 + length > body.length) throw new WireError('gRPC message is truncated');
    yield { compressed: flag === 1, payload: body.subarray(offset + 5, offset + 5 + length) };
    offset += 5 + length;
  }
}
