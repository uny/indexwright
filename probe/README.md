# The measured run

`check` has never been executed against a real database. Every test it landed with is offline and
none of them opens a channel — so the verb's network path, and the one claim its verdicts rest on,
have never been observed. This directory is the harness for the first run that
observes them.

It answers four things at once, which is why it is worth doing before anything else:

| Question | Instrument | Status before this run |
|:--|:--|:--|
| SPEC §7's claim: index selection does not depend on the compared value | `differential.mjs`, run either side of the deploy | Unverified, and §7 itself asks that it be tested |
| Issue #43: a negated operator reads the whole collection | `differential.mjs`, on a seeded collection | Deduced, never observed |
| Issue #39: the process exits once the report is written | `check`, timed | Untestable with a fake client |
| `DEFAULT_SETTLE_MS` = 60s | `watch-readiness.mjs` | A guess |

Index builds dominate the wall clock — roughly three and a half minutes each — so the design
deploys **one** index set and varies the corpus against it. That reaches `check`'s exit 0, 1 and 2
paths without a second build.

The §7 question is asked twice, and the first asking costs no build at all: against a bare target
every shape needing an index should fail for every operand, so any `served` there stops the run —
either the claim is false in the direction that matters most, or the target was not bare — and it is
answered before a minute of wall clock is spent.

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

Five hundred documents. `a` is seeded to the sentinel itself, because S4 conjoins an equality on
`a` with the negated filter and replay sends the sentinel to both — seeded to anything else, S4
matches nothing and measures nothing. `b` is deliberately of mixed type: a `!=` matches every
document where the field exists and differs, whatever its type, and that is the read volume #43 is
about. The one exception is `null`, which a `!=` does not match, so the count to expect back is the
seeded count minus those rows. `seed.mjs` prints it.

```bash
node probe/seed.mjs indexwright-probe '(default)' 500
```

### 3. The differential probe, before any index exists

Run it once here, with the target still bare. It costs no index build, so none of the three and a
half minutes the rest of the run is paced by — and it is the reading that matters most.

With no composite index deployed, every shape that needs one should come back
`FAILED_PRECONDITION` for **every** operand. A `served` among them is the reading to stop on, and it
arrives in one of two forms the instrument reports differently. Mixed with `uncovered` inside a
single shape, it is SPEC §7 falsified in the direction that matters — the sentinel fails where a
real value succeeds, so `check` would report a query uncovered that the application issues happily,
the false positive §2 forbids acting on — and the probe prints `FALSIFIES SPEC §7` and exits `1`.
Uniform across every operand of that shape, it is not a §7 finding at all, and the probe cannot say
so: it compares verdicts only *within* a shape, so it prints `constant … served` and exits `0`. What
that means is that the target was not bare — step 1 was misread, or run against another database —
and the whole reading is of the covered side. The instrument has no signal for it, which is why the
stop rule below names it explicitly.

```bash
node probe/differential.mjs indexwright-probe '(default)' > probe/differential-before.json
```

Read the stderr summary. Per shape it prints `constant across N operands`, or
`FALSIFIES SPEC §7` with the disagreeing variants. Exit `0` means the claim survived, `1` means it
did not, `2` means a shape had too few operands reach the backend to say — and `2` outranks `1`, so
a run that both falsified the claim and left a shape unanswered exits `2`. That is `check`'s own
contract: a report missing entries is not a clean report with a caveat. `2` is also what the guards
exit with before a single shape is issued — a `FIRESTORE_EMULATOR_HOST` still exported from an
earlier session, or no project argument — and they exit before the first byte of stdout, so the
redirect leaves `differential-before.json` empty rather than partial. An empty report is that, and
not a measurement of anything.

So the reading this step has to produce, shape by shape: **S7 `constant … served`, and every one of
the other seven `constant … uncovered`.** S7 is the only shape needing no composite index — its `a`
equality and `__name__` inequality are served by the automatic single-field index — which is why
`shapes.mjs` predicts it `covered: true` while `firestore.indexes.json` declares nothing for it. Do
not read `covered` as the expectation here: it is a prediction about the *deployed* set, and it is
`true` for S1–S5 as well, every one of which needs a composite the bare target does not hold.

**Stop here, and do not deploy, on any of three readings**, because the probe's exit status alone
distinguishes only the first:

- a shape printing `FALSIFIES SPEC §7` — the claim is false, and exit `1` says so;
- any shape other than S7 printing `constant … served` — the target was not bare, and the exit
  status is `0`, so this one is caught by reading the summary or not at all;
- a non-zero exit for any other reason — a shape `UNTESTED`, or a guard refusing to run. The
  question was not answered, and an unanswered §7 is not a survived §7.

In all three the claim the verb rests on is either false or unmeasured, the design question is what
`check` can honestly report without it, and nothing further down this runbook is worth the wall
clock until that is answered.

### 4. Deploy the candidate set, and watch it settle

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

### 5. The differential probe again, now that the set is there

The same instrument against the covered side. Step 3 could only show the claim holding where nothing
is served; this shows it holding where something is, and this is where issue #43's number comes
from — a shape that came back `FAILED_PRECONDITION` read nothing.

```bash
node probe/differential.mjs indexwright-probe '(default)' > probe/differential-after.json
```

The summary reads the same way as in step 3, but the expected reading inverts: S1–S5 and S7
`constant … served`, and S6 and S8 `constant … uncovered` — those two are the shapes the candidate
set deliberately does not declare. So the middle prong of step 3's stop rule does not carry over;
`served` is what success looks like here. The other two do carry over: stop on a shape printing
`FALSIFIES SPEC §7`, and stop on a non-zero exit, before reading anything below for #43 or handing
ids to step 6.

A falsification here is the claim failing on the covered side, and which direction it fails in is
read off the disagreeing variants rather than assumed. The sentinel served where a real operand is
not is the false negative — `check` reports served what a real query cannot get served. The sentinel
uncovered where a real operand is served is step 3's false positive again, on the other side of the
deploy.

**For #43**, read the `documents read` count on the S4 **`sentinel`** row — that row and no other,
because it is the only one issuing what `check` actually replays. `seed.mjs` prints the number to
expect when it finishes: **429** for a 500-document seed, being every seeded document except the 71
whose `b` is null, which a `!=` does not match. If it reports 429, #43's deduction is now an
observation. If it reports 0, the seed did not take — the seeded `a` is the sentinel precisely so
that a healthy collection cannot report 0 here.

The other S4 rows are expected to report 0: they vary the operand, and the operand is the value the
equality is matched against, so `a == 42` matches nothing in a collection seeded to the sentinel.
That is a statement about the variant, not about the seed.

### 6. Capture the corpus of shapes the target actually covers

Which shapes are covered is a result of step 5, not an assumption. Take the ids the probe reported
`constant … served` and capture a corpus of exactly those, through `record` rather than by editing
the full one — the entries `check` replays have to be entries `record` wrote.

Start the emulator in one terminal, from `probe/`:

```bash
firebase emulators:start --only firestore --project indexwright-probe
```

Then, from the repository root, substituting the ids from step 5 — every `node` command in this
runbook is written relative to the root, and only the two `firebase` commands run from `probe/`:

```bash
PROBE_SHAPES=S1,S2,S3,S4,S5,S7 node packages/record/dist/cli.js --emulator 127.0.0.1:8080 --out probe/firestore.covered.json -- node probe/suite.mjs
```

### 7. `check`, three ways

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
