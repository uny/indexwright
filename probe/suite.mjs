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

// The inverse of the guard `differential.mjs` and `seed.mjs` carry, for the same reason and in the
// other direction: those two must not be redirected away from the named database, and this one must
// not be pointed *at* it. `record` sets this variable to its proxy, so its absence means nothing is
// capturing — the client would resolve application default credentials, issue all eight shapes at
// the real target, and write no corpus at all. The run would then look like a success: the shapes
// the emulator would have rejected come back `FAILED_PRECONDITION` instead, which this file already
// prints as "answered with an error", and step 5's `--out` file is left as whatever it was. A stale
// corpus replayed by `check` is the clean report that is really a missing measurement.
if (process.env['FIRESTORE_EMULATOR_HOST'] === undefined || process.env['FIRESTORE_EMULATOR_HOST'] === '') {
  process.stderr.write(
    'probe-suite: refusing to run with FIRESTORE_EMULATOR_HOST unset — nothing would capture the\n' +
      'probe-suite: shapes and the queries would reach the real database. Run under `indexwright-record`.\n',
  );
  process.exit(2);
}

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
let selected = SHAPES;
if (only !== undefined && only !== '') {
  const requested = only.split(',').map((id) => id.trim()).filter((id) => id !== '');
  // Refused rather than dropped. The ids are retyped by hand from step 4's output, so a lowercase
  // `s7` or an id renamed since is the expected mistake — and filtering it away silently captures a
  // corpus one entry short, which `check` then replays to a clean exit 0 over a query the run
  // believed it had covered. Only an *entirely* unrecognised list used to be caught, which is the
  // one case the typo is least likely to produce.
  const unknown = requested.filter((id) => !SHAPES.some((shape) => shape.id === id));
  if (unknown.length > 0) {
    process.stderr.write(
      `probe-suite: PROBE_SHAPES names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a shape' : 'are not shapes'} — ` +
        `known ids are ${SHAPES.map((shape) => shape.id).join(', ')}\n`,
    );
    process.exit(2);
  }
  selected = SHAPES.filter((shape) => requested.includes(shape.id));
}

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

// Against `selected`, not `SHAPES`: a deliberate six-shape subset printing "6 of 8" reads as two
// shapes having failed. The full set is named too, so the subset is still visible as a subset.
process.stderr.write(
  `probe-suite: issued ${issued} of ${selected.length} selected shapes (${SHAPES.length} defined)\n`,
);
await db.terminate();
