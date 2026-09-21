import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameSplitter, WireError } from '../dist/index.js';

/** Frame a payload the way gRPC does, with the compressed flag given. */
function frame(payload, compressed = false) {
  const header = Buffer.alloc(5);
  header[0] = compressed ? 1 : 0;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const payloads = (frames) => frames.map((f) => ('tooLarge' in f ? 'tooLarge' : Buffer.from(f.payload).toString()));

test('frames are yielded as they complete, however the bytes are cut', () => {
  const bytes = Buffer.concat([frame(Buffer.from('one')), frame(Buffer.from('two'), true), frame(Buffer.alloc(0))]);
  for (const cut of [1, 2, 5, 7, bytes.length]) {
    const splitter = new FrameSplitter(1024);
    const seen = [];
    for (let offset = 0; offset < bytes.length; offset += cut) {
      seen.push(...splitter.push(bytes.subarray(offset, offset + cut)));
    }
    assert.deepEqual(payloads(seen), ['one', 'two', ''], `cut every ${cut} bytes`);
    assert.deepEqual(
      seen.map((f) => f.compressed),
      [false, true, false],
    );
    splitter.end();
  }
});

test('a frame past the cap is dropped by its declared length and the next frame still reads', () => {
  // Bounded per frame rather than per stream: a Listen stream carries more over its life than any
  // one message may, and giving up on the stream at the first big frame would lose every target
  // added after it.
  const big = Buffer.alloc(100, 0x61);
  const bytes = Buffer.concat([frame(Buffer.from('before')), frame(big), frame(Buffer.from('after'))]);
  for (const cut of [1, 3, 50, bytes.length]) {
    const splitter = new FrameSplitter(16);
    const seen = [];
    for (let offset = 0; offset < bytes.length; offset += cut) {
      seen.push(...splitter.push(bytes.subarray(offset, offset + cut)));
    }
    assert.deepEqual(payloads(seen), ['before', 'tooLarge', 'after'], `cut every ${cut} bytes`);
    splitter.end();
  }
});

test('bytes left at the end of the stream are a fault, and so is a bad flag', () => {
  const partial = new FrameSplitter(1024);
  assert.deepEqual([...partial.push(frame(Buffer.from('x')).subarray(0, 4))], []);
  assert.throws(() => partial.end(), WireError);

  const dropping = new FrameSplitter(4);
  assert.deepEqual(payloads([...dropping.push(frame(Buffer.alloc(10)).subarray(0, 8))]), ['tooLarge']);
  assert.throws(() => dropping.end(), WireError);

  const flagged = new FrameSplitter(1024);
  assert.throws(() => [...flagged.push(Buffer.from([0x02, 0, 0, 0, 0]))], WireError);

  new FrameSplitter(1024).end();
});
