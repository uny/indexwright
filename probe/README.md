# The measured run

`check` has never been executed against a real database. The 336 tests it shipped with are all
offline, and none of them opens a channel — so the verb's network path, and the one claim its
verdicts rest on, have never been observed. This directory is the harness for the first run that
observes them.

It answers four things at once, which is why it is worth doing before anything else:

| Question | Instrument | Status before this run |
|:--|:--|:--|
| SPEC §7's claim: index selection does not depend on the compared value | `differential.mjs` | Unverified, and §7 itself asks that it be tested |
| Issue #43: a negated operator reads the whole collection | `differential.mjs`, on a seeded collection | Deduced, never observed |
| Issue #39: the process exits once the report is written | `check`, timed | Untestable with a fake client |
| `DEFAULT_SETTLE_MS` = 60s | `watch-readiness.mjs` | A guess |

Index builds dominate the wall clock — roughly three and a half minutes each — so the design
deploys **one** index set and varies the corpus against it. That reaches `check`'s exit 0, 1 and 2
paths without a second build.

## Why `check` cannot test §7 by itself

`check` only ever sends the one value `replay.ts` synthesises, so it agrees with itself whatever the
truth is. `differential.mjs` issues each shape repeatedly against the real database, changing only
the operands, and compares the verdicts.

**The falsification condition:** for one shape, two variants that both reached the backend disagree
on served versus `FAILED_PRECONDITION`. A variant rejected as `INVALID_ARGUMENT` never reached the
question and is excluded from the comparison, though it is still reported.

The sharpest way the claim could be false is **operand arity**. The corpus does not record how many
values an `IN` carried, so a three-value `IN` is replayed as a one-value `IN`. If that changes which
index serves it, `check` reports a verdict for a query the suite never issued. `list-of-three` and
`list-of-ten` are variants for exactly this.

`null` and `NaN` are deliberately not variants: the SDK converts an equality against either into a
*unary* filter on the wire, so substituting one records a different shape rather than the same shape
with a different value. S5 covers the unary form as its own entry.

## What is already done, and what it already found

The corpus is captured and committed. Capture runs against the emulator and needs no credentials, so
it was done ahead of the run — and it found a bug in shipped code before a single call reached GCP:

> `REPLAY_SENTINEL` was `__indexwright_replay__`, and Firestore reserves every document id matching
> `__…__`. Every corpus entry carrying a `__name__` filter therefore replayed as `INVALID_ARGUMENT`
> — which is the failure SPEC §7 says the reference operand exists to avoid, arriving by the other
> door. The suite could not catch it: every test builds both the actual and the expected query from
> the constant, so the two moved together and the comparison stayed true. Fixed, with a test that
> pins the rule against a literal instead.

## Files

| File | What it is |
|:--|:--|
| `shapes.mjs` | The eight query shapes, defined once and shared by both instruments so they cannot drift apart |
| `suite.mjs` | The driver `record` captures from. `PROBE_SHAPES=S1,S2` issues a subset |
| `differential.mjs` | The §7 instrument. Writes a JSON report to stdout |
| `seed.mjs` | Populates the collection, so #43's cost is observed rather than deduced |
| `watch-readiness.mjs` | Timestamped index states through the same Admin path `check` uses |
| `firestore.queries.json` | The captured corpus. Committed — it is the input `check` replays |
| `firestore.indexes.json` | The candidate set, deployed to the target |
| `firestore.indexes.wrong.json` | A set that is *not* the deployed one, for the exit-2 divergence path |

`covered` in `shapes.mjs` is a **prediction**, written down so the run can falsify it. Neither
instrument consults it.

## Credentials

Three separate stores, and they are not interchangeable:

- **Application default credentials** — what `check`, `differential.mjs`, `seed.mjs` and
  `watch-readiness.mjs` use. `gcloud auth login` does *not* set these.
- **gcloud's own login** — only needed for `gcloud` commands.
- **firebase login** — only needed for `firebase deploy`.

```bash
gcloud auth application-default login
```

⚠️ gcloud's default project is a client's dev project. **Every `gcloud` command below passes
`--project indexwright-probe` explicitly.** A run against the wrong target returns a clean report
rather than an error, which is the failure that looks most like success.

## The run

Build first — `shapes.mjs` and `watch-readiness.mjs` both import from the built package, and the
differential probe's `sentinel` variant has to be literally the value `replay.ts` sends.

```bash
npm run build
```

### 1. Confirm the target holds no composite indexes yet

`check` refuses to report unless the live set *is* the candidate set, so anything left over from an
earlier experiment makes every run below exit 2.

```bash
gcloud firestore indexes composite list --project indexwright-probe --database '(default)'
```

### 2. Seed the collection

Five hundred documents, with `b` deliberately of mixed type — a `!=` matches every document where
the field exists and differs, whatever its type, and that is the read volume #43 is about.

```bash
node probe/seed.mjs indexwright-probe '(default)' 500
```

### 3. Deploy the candidate set, and watch it settle

Start the watcher **first**, in a second terminal, so the deploy's transitions are inside the window
it observes. What calibrates `DEFAULT_SETTLE_MS` is not when the first `READY` appears but the
interval to the *last* transition after it.

```bash
node probe/watch-readiness.mjs indexwright-probe '(default)' 900
```

Then, from `probe/`:

```bash
firebase deploy --only firestore:indexes --project indexwright-probe
```

### 4. The differential probe — SPEC §7 and issue #43

```bash
node probe/differential.mjs indexwright-probe '(default)' > probe/differential.json
```

Read the stderr summary. Per shape it prints `constant across N operands`, or
`FALSIFIES SPEC §7` with the disagreeing variants. Exit `0` means the claim survived, `1` means it
did not, `2` means a shape had too few operands reach the backend to say.

**For #43**, read the `documents read` counts on the S4 rows. If they equal the 500 seeded, the
issue's deduction is now an observation. If they are zero, the seed did not take.

### 5. Capture the corpus of shapes the target actually covers

Which shapes are covered is a result of step 4, not an assumption. Take the ids the probe reported
`constant … served` and capture a corpus of exactly those, through `record` rather than by editing
the full one — the entries `check` replays have to be entries `record` wrote.

Start the emulator in one terminal, from `probe/`:

```bash
firebase emulators:start --only firestore --project indexwright-probe
```

Then, substituting the ids from step 4:

```bash
PROBE_SHAPES=S1,S2,S3,S4,S5,S7 node packages/record/dist/cli.js --emulator 127.0.0.1:8080 --out probe/firestore.covered.json -- node probe/suite.mjs
```

### 6. `check`, three ways

Time each one. **Issue #39 is answered by whether the process exits at all** once the report is
written, so a run that prints its last line and then sits there is the finding.

The full corpus against the deployed set — predicted **exit 1**, naming S6 and S8:

```bash
time node packages/record/dist/cli.js check --project indexwright-probe --database '(default)' --corpus probe/firestore.queries.json --indexes probe/firestore.indexes.json
```

The covered subset against the same set — predicted **exit 0**:

```bash
time node packages/record/dist/cli.js check --project indexwright-probe --database '(default)' --corpus probe/firestore.covered.json --indexes probe/firestore.indexes.json
```

A candidate file that is not the deployed set — predicted **exit 2**, reporting the divergence
rather than a coverage verdict. This one costs no index build:

```bash
time node packages/record/dist/cli.js check --project indexwright-probe --database '(default)' --corpus probe/firestore.queries.json --indexes probe/firestore.indexes.wrong.json
```

## Afterwards

The target is a throwaway database and this harness never deletes anything. Clearing the seeded
collection, and removing the deployed indexes, is yours to do when the run is finished.
