/**
 * Timestamped index states, for calibrating `DEFAULT_SETTLE_MS`.
 *
 * 60s is a guess. What it is trying to bound is the window after every index reports `READY` in
 * which the set can still change — so what has to be observed is the interval between a deploy and
 * the last transition the Admin API reports, not just the moment the first `READY` appears.
 *
 * This deliberately goes through `adminLister` and `listLiveIndexes`, the same path `check` uses,
 * so it observes what `check` observes rather than what a second client would. `gcloud` would need
 * its own credentials besides — it keeps a different store from application default credentials.
 *
 * The lister is built once and kept, which is what `IndexLister` documents as the supported use:
 * closing it per poll would rebuild the channel on every tick.
 *
 * Requires `npm run build` first. Usage: node probe/watch-readiness.mjs <project> [database] [seconds]
 */

import { adminLister, listLiveIndexes } from '../packages/record/dist/index.js';

const [project, database = '(default)', rawSeconds = '600'] = process.argv.slice(2);
if (project === undefined) {
  process.stderr.write('probe-watch: usage: node probe/watch-readiness.mjs <project> [database] [seconds]\n');
  process.exit(2);
}

const seconds = Number(rawSeconds);
if (!Number.isFinite(seconds) || seconds <= 0) {
  process.stderr.write(`probe-watch: ${rawSeconds} is not a duration in seconds\n`);
  process.exit(2);
}

// `canonicalTarget` is the CLI's own business and is not exported, so the one line it is gets
// written out here. Nothing else is restated: `listIndexesAsync`'s parent, the wildcard that lists
// every collection group, and the paging are all inside `listLiveIndexes`, which is imported.
const target = `projects/${project}/databases/${database}`;
const lister = await adminLister(project);

/** One line per listing, but only when it differs from the last — a poll that repeats is unread. */
let previous;
const started = Date.now();
const deadline = started + seconds * 1000;
try {
  while (Date.now() < deadline) {
    const live = await listLiveIndexes(target, lister);
    const summary = live
      .map((index) => `${String(index.name).split('/').pop()}=${index.state}`)
      .sort()
      .join(' ');
    if (summary !== previous) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      process.stderr.write(`probe-watch: +${elapsed}s [${new Date().toISOString()}] ${live.length} indexes: ${summary || '(none)'}\n`);
      previous = summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
} finally {
  // The same reason `check` closes it in a `finally` (issue #39): the channel refs the event loop,
  // so without this the process prints its last line and then sits there.
  await lister.close();
}

process.stderr.write(`probe-watch: watched for ${seconds}s\n`);
