/**
 * Populate the throwaway collection, so that issue #43's cost is observed rather than deduced.
 *
 * #43 says a negated operator replays as a read of the whole collection: the synthesised sentinel
 * matches nothing for an equality, but `!=` matches every document that merely *has* the field, and
 * `get()` buffers all of them. Against an empty collection that reads as zero documents and the
 * claim stays a deduction — which is what it is today. The count this seeds is the number the
 * differential probe should report back for S4.
 *
 * Writes only. Nothing here deletes: the target is a throwaway database, and clearing it is the
 * operator's call rather than a script's.
 *
 * Usage: node probe/seed.mjs <project> [database] [count]
 */

import { Firestore } from '@google-cloud/firestore';
import { COLLECTION } from './shapes.mjs';

for (const name of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN']) {
  if (process.env[name] !== undefined && process.env[name] !== '') {
    process.stderr.write(`probe-seed: refusing to run while ${name} is set\n`);
    process.exit(2);
  }
}

const [project, database = '(default)', rawCount = '500'] = process.argv.slice(2);
if (project === undefined) {
  process.stderr.write('probe-seed: usage: node probe/seed.mjs <project> [database] [count]\n');
  process.exit(2);
}

const count = Number(rawCount);
if (!Number.isInteger(count) || count <= 0) {
  process.stderr.write(`probe-seed: ${rawCount} is not a document count\n`);
  process.exit(2);
}

const db = new Firestore({ projectId: project, databaseId: database });
const collection = db.collection(COLLECTION);

// `b` is deliberately of mixed type across the corpus of documents. A `!=` matches every document
// where the field exists and differs, whatever its type, so mixing them is what makes S4 read the
// whole collection rather than the subset that happens to be strings.
const B = ['alpha', 'beta', 42, true, null, { k: 1 }, [1, 2]];

// The batch limit is 500 writes. Chunked rather than assumed, so a larger count does not fail
// halfway with part of the collection seeded.
const CHUNK = 400;
let written = 0;
while (written < count) {
  const batch = db.batch();
  const upTo = Math.min(written + CHUNK, count);
  for (let i = written; i < upTo; i += 1) {
    batch.set(collection.doc(`doc-${String(i).padStart(5, '0')}`), {
      a: i % 3 === 0 ? 'beta' : `a-${i % 7}`,
      b: B[i % B.length],
      n: i,
      tags: ['beta', `t-${i % 5}`],
    });
  }
  await batch.commit();
  written = upTo;
  process.stderr.write(`probe-seed: ${written}/${count}\n`);
}

process.stderr.write(`probe-seed: seeded ${written} documents into ${COLLECTION}\n`);
await db.terminate();
