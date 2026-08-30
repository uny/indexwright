/**
 * Populate the throwaway collection, so that issue #43's cost is observed rather than deduced.
 *
 * #43 says a negated operator replays as a read of the whole collection: the synthesised sentinel
 * matches nothing for an equality, but `!=` matches every document that merely *has* the field, and
 * `get()` buffers all of them. Against an empty collection that reads as zero documents and the
 * claim stays a deduction — which is what it is today.
 *
 * **`a` is seeded to the sentinel itself, and that is what makes S4 measure anything.** S4 is
 * `a == <operand> AND b != <operand>`, so the equality is a *conjunct*, not a preamble: seeded with
 * any other value it matches nothing when the operand is the sentinel, S4 returns zero documents
 * against a perfectly healthy collection, and the reading is indistinguishable from a seed that
 * never ran. Replay only ever sends the sentinel — `replay.ts` synthesises it for both filters — so
 * the collection that reproduces what `check` actually issues is the one where every document
 * satisfies the equality, leaving the `!=` as the only thing bounding the read. That is #43's claim
 * stated as a collection rather than as an argument.
 *
 * The count to expect back is therefore *not* `count`: Firestore's `!=` excludes documents whose
 * field is null as well as those where it is absent, and `b` is null for one seeded document in
 * every `B.length`. See the `B` comment below, and `README.md` step 5 for the arithmetic.
 *
 * Writes only. Nothing here deletes: the target is a throwaway database, and clearing it is the
 * operator's call rather than a script's.
 *
 * Requires `npm run build`, which the runbook asks for first: the sentinel is imported from the
 * built package through `shapes.mjs` rather than spelled again here, for the reason that file
 * gives — a second spelling would seed a collection that replay's own operand does not match.
 *
 * Usage: node probe/seed.mjs <project> [database] [count]
 */

import { Firestore } from '@google-cloud/firestore';
import { COLLECTION, SENTINEL, seededId } from './shapes.mjs';

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
//
// `null` is the exception, and it is kept deliberately rather than removed. Firestore's `!=` does
// *not* match a null-valued field — measured against the emulator: 500 documents, 71 with `b: null`,
// `b != <sentinel>` returns 429 — so these rows are the difference between the seeded count and the
// count S4 reports. They are worth keeping because S5 (`b == null`) is a shape in its own right and
// needs them; what would be wrong is to seed them and then expect S4 to count them.
const B = ['alpha', 'beta', 42, true, null, { k: 1 }, [1, 2]];

/** How many of `count` documents a `!=` on `b` will not match, because their `b` is null. */
function nullCount(count) {
  const nulls = B.filter((value) => value === null).length;
  return Math.floor(count / B.length) * nulls + B.slice(0, count % B.length).filter((v) => v === null).length;
}

// The batch limit is 500 writes. Chunked rather than assumed, so a larger count does not fail
// halfway with part of the collection seeded.
const CHUNK = 400;
let written = 0;
while (written < count) {
  const batch = db.batch();
  const upTo = Math.min(written + CHUNK, count);
  for (let i = written; i < upTo; i += 1) {
    batch.set(collection.doc(seededId(i)), {
      // The sentinel, so S4's equality conjunct does not bound the read — see the module comment.
      a: SENTINEL,
      b: B[i % B.length],
      n: i,
      tags: [SENTINEL, `t-${i % 5}`],
    });
  }
  await batch.commit();
  written = upTo;
  process.stderr.write(`probe-seed: ${written}/${count}\n`);
}

process.stderr.write(`probe-seed: seeded ${written} documents into ${COLLECTION}\n`);
// The number to hold the differential probe to, computed here rather than left to the operator to
// derive: S4 reads every seeded document except the ones a `!=` skips for being null.
// Named down to the row, because seven of S4's eight rows will report 0 and this line is where the
// operator meets the number first: the other rows vary the operand, and the operand is what the
// equality on `a` is matched against, so only the sentinel row addresses this collection at all.
process.stderr.write(
  `probe-seed: S4's \`sentinel\` row should report ${written - nullCount(written)} documents read ` +
    `(${written} seeded, ${nullCount(written)} with a null \`b\`, which \`!=\` does not match); ` +
    `S4's other rows should report 0\n`,
);
await db.terminate();
