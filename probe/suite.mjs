/**
 * The driver suite `record` captures a corpus from.
 *
 * Run under `indexwright-record`, which points `FIRESTORE_EMULATOR_HOST` at its proxy. Every shape
 * in `shapes.mjs` is issued once; the corpus that comes out is what `check` later replays against
 * the real database.
 *
 * Values are the sentinel throughout, and that costs nothing: capture records shape only, so the
 * operands here never reach the corpus. Varying them is the differential probe's job.
 *
 * Each query is awaited inside its own `try`. A query enters the corpus when its *request* is
 * observed, whatever the emulator answers next (SPEC §7), so a shape the emulator rejects is still
 * captured — and stopping on it would silently shorten the corpus instead.
 */

import { Firestore } from '@google-cloud/firestore';
import { COLLECTION, SENTINEL, SHAPES } from './shapes.mjs';

const db = new Firestore({ projectId: 'indexwright-probe' });
const collection = db.collection(COLLECTION);

const values = {
  scalar: () => SENTINEL,
  list: () => [SENTINEL],
  ref: () => collection.doc(SENTINEL),
};

/**
 * Which shapes to issue, as a comma-separated list of ids, or all of them.
 *
 * The exit-0 run needs a corpus holding only the entries the target actually covers, and which
 * those are is not known until the differential probe has answered — the `covered` field in
 * `shapes.mjs` is a prediction to be falsified, not an input. So the subset is selected here and
 * captured through `record` like any other corpus, rather than produced by editing the full one:
 * a hand-edited corpus is a file this repository authored, and the entries `check` replays have to
 * be entries `record` wrote.
 */
const only = process.env['PROBE_SHAPES'];
const selected =
  only === undefined || only === ''
    ? SHAPES
    : SHAPES.filter((shape) => only.split(',').map((id) => id.trim()).includes(shape.id));

if (selected.length === 0) {
  process.stderr.write(`probe-suite: PROBE_SHAPES=${only} selected no shape\n`);
  process.exit(2);
}

let issued = 0;
for (const shape of selected) {
  try {
    await shape.build(collection, values).get();
  } catch (error) {
    // Reported, never swallowed: the emulator enforces no composite indexes, so anything failing
    // here is a malformed query rather than a missing index, and a malformed query captured as a
    // corpus entry would send `check` to ask the real database a question the suite never asked.
    process.stderr.write(`probe-suite: ${shape.id} was answered with an error: ${error.message}\n`);
  }
  issued += 1;
}

process.stderr.write(`probe-suite: issued ${issued} of ${SHAPES.length} shapes\n`);
await db.terminate();
