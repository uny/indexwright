# The measured run

`check` landed without ever having been executed against a real database. Every test it landed with
is offline and none of them opens a channel, so the verb's network path — and the one claim its
verdicts rest on — went unobserved. This directory is the harness for the run that observed them, and
the runbook below is the one that was followed.

It answered four things at once, which is why it was worth doing before anything else:

| Question | Instrument | Status before the run | What the run observed |
|:--|:--|:--|:--|
| SPEC §7's claim: index selection does not depend on the compared value | `differential.mjs`, run either side of the deploy | Unverified, and §7 itself asks that it be tested | **Holds on the axes tested.** Every shape constant across every operand, both sides, arity included — see §7 for what it does not reach |
| Issue #43: a negated operator reads the whole collection | `differential.mjs`, on a seeded collection | Deduced, never observed | **429 documents**, the predicted count |
| Issue #39: the process exits once the report is written | `check`, timed | Untestable with a fake client | **It exits.** Three runs, none hung |
| `DEFAULT_SETTLE_MS` = 60s | `watch-readiness.mjs` | A guess | Still a guess, now a documented one — see below |

Index builds dominate the wall clock — roughly three and a half minutes each — so the design
deploys **one** index set and varies the corpus against it. That reaches `check`'s exit 0, 1 and 2
paths without a second build.

The §7 question is asked twice, and the first asking costs no build at all: against a bare target
every shape a composite index is the only way to serve should fail for every operand, so a `served`
on one of those stops the run — either the claim is false, or the target was not bare — and it is
answered before a minute of wall clock is spent. Both readings exit non-zero: the probe is told what
to expect, so nothing about the stop rule depends on the summary being read closely.

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

## What the run found

Four shapes were left out of the `--expect-` flags at the step that asked about them — S2, S3 and S5
before the deploy, S8 after it — because each asks something the run existed to *observe*, and a
wrong guess in a flag stops a correct run. Their readings, recorded rather than scored:

- **S8 — a declared `(a ASC, b ASC)` did not serve an order by `b desc`.** The shape came back
  `FAILED_PRECONDITION` with that index deployed and `READY`. The reading is what one would expect if
  direction is part of the index rather than something the planner inverts, and it is the reason to
  expect that a suite ordering one way and an index ordering the other do not meet — but it is one
  shape against one set, which is not enough to state the planner rule itself.
- **S3 — `array-contains` with an equality is served with no composite index.** It read `served` on a
  bare target, where S1, S4, S6 and S8 all read `uncovered` and the listing in step 1 showed nothing
  deployed, so this is a merge and not a dirty target. The candidate set declares a
  `tags CONTAINS, a ASC` composite that S3 does not appear to need. One run is thin evidence for
  deleting an index, but it is the reading on record.
- **S2 and S5 — equality-only shapes are merged.** Both served on a bare target: an `IN` expands into
  equality branches and `b == null` is an equality, and single-field indexes cover that class.

The arity result belongs with them, though it was never in question in a flag: S2 at one, three and
ten values was served identically. That is the axis the corpus discards, and the sharpest way SPEC §7
could have been false.

### On the settling period

The watcher polls every five seconds. It first saw both indexes `CREATING` at +36s, first saw both
`READY` in the same poll at +337s, and saw nothing transition through the remaining 900-second
window. So the only interval a state watcher can measure, first `READY` to last transition, was zero
— and "together" means within one poll, not simultaneously.

That is not the interval `DEFAULT_SETTLE_MS` covers. The window it guards opens once every index
already reports `READY`, so nothing transitioning afterwards is what a healthy deploy looks like, and
the constant was left at 60s: what it guards is a rare transient that has never been timed, and a run
that does not reproduce a rare event says nothing about how long it lasts.

What the run did settle is the price. The readiness gate restarts on every invocation, so each
`check` pays the full period no matter how long the set has been ready — the three timed runs took
62, 63 and 62 seconds against a two-index database, which is nearly all of it.

## Files

| File | What it is |
|:--|:--|
| `shapes.mjs` | The eight query shapes, defined once and shared by both instruments so they cannot drift apart |
| `suite.mjs` | The driver `record` captures from. `PROBE_SHAPES=S1,S2` issues a subset |
| `differential.mjs` | The §7 instrument: issues the shapes, writes a JSON report to stdout |
| `expectations.mjs` | Its command line — argv in, the expectation map out. Pure, so what an operator types is testable |
| `summarise.mjs` | Its stop rule — rows in, findings and an exit code out. Pure, so it can be tested without a database |
| `expectations.test.mjs`, `summarise.test.mjs` | Tests for the two halves of the stop rule. Run in `npm test` alongside the packages' suites |
| `seed.mjs` | Populates the collection, so #43's cost is observed rather than deduced |
| `watch-readiness.mjs` | Timestamped index states through the same Admin path `check` uses |
| `firestore.queries.json` | The captured corpus. Committed — it is the input `check` replays |
| `firestore.indexes.json` | The candidate set, deployed to the target |
| `firestore.indexes.wrong.json` | A set that is *not* the deployed one, for the exit-2 divergence path |

`covered` in `shapes.mjs` is a **prediction**, written down so the run can falsify it. Neither
instrument consults it, and the `--expect-` flags are passed the runbook's predictions by hand
rather than reading it — which is what keeps a prediction from being able to block a correct run
without someone having typed it.

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
single shape, it is SPEC §7 falsified: the probe prints `FALSIFIES SPEC §7` with the per-variant
mapping and exits `1`. Uniform across every operand of that shape, it is not a §7 finding at all,
and the probe cannot see it on its own: it compares verdicts only *within* a shape, so it would
print `constant … served` and exit `0`. What that means is that the target was not bare — step 1 was
misread, or run against another database — and the whole reading is of the covered side.

That is what `--expect-uncovered` is for. The expectation below is *supplied* to the probe rather
than left for a reader to check the summary against, so a shape answering against it exits `2`
instead of printing a line that has to be noticed. The predictions stay here, in prose, where they
can be argued with; the instrument holds only the mechanism.

```bash
node probe/differential.mjs indexwright-probe '(default)' \
  --expect-uncovered S1,S4,S6,S8 --expect-served S7 \
  > probe/differential-before.json
```

S2, S3 and S5 are named by neither flag, deliberately — see the second and third groups below. Only
a prediction that cannot come out the other way belongs in a flag: what a flag buys is that nobody
has to notice a line, and what it costs is that a correct run can be stopped by a guess.

Read the stderr summary. Per shape it prints `constant across N of M operands`, or
`FALSIFIES SPEC §7` with the disagreeing variants. Exit `0` means the claim survived, `1` means it
did not, and `2` means the run could not answer — a shape with too few operands to say, an operand
that never entered the comparison, or a shape answering against a supplied expectation. `2` outranks
`1`, so a run that both falsified the claim and left a shape unanswered exits `2`. That is `check`'s
own contract: a report missing entries is not a clean report with a caveat. `2` is also what the guards
exit with before a single shape is issued — a `FIRESTORE_EMULATOR_HOST` still exported from an
earlier session, or no project argument — and they exit before the first byte of stdout, so the
redirect leaves `differential-before.json` empty rather than partial. An empty report is that, and
not a measurement of anything.

So the reading this step has to produce, in four groups — and only the first of them is a group a
`served` can be read against, which is why only that group and S7 are handed to the flags:

- **S1, S4, S6 and S8 `constant … uncovered`, and these four are in the flag.** Each carries a
  range, an inequality or an order-by on a second field, and a composite index is the only way
  Firestore serves those. On a bare target there is no room for any of the four to come back
  anything else, which is what makes them safe to hand to `--expect-uncovered`.
- **S3 `constant … uncovered` too — but predicted, not enforced.** It pairs an `array-contains` with
  an equality, which is not the equality-only case, and it is the field pair
  `firestore.indexes.json` declares its second composite for, so the candidate set is itself the
  claim that S3 needs one. What keeps it out of the flag is the other reading: if Firestore merges
  an `array-contains` with an equality after all, `served` here is a correct answer from a bare
  target, and a flag would have stopped the run for it. Read S3's line, and if it is `served` — and
  the four above are not — confirm against step 1's listing before concluding the target was dirty.
- **S7 `constant … served`.** It is the one shape certain to be served here: its `a` equality and
  `__name__` inequality are served by the automatic single-field index, which is why `shapes.mjs`
  predicts it `covered: true` while `firestore.indexes.json` declares nothing for it.
- **S2 and S5 either way — and which way is itself a result worth writing down.** Both are
  equality-only shapes: an `IN` expands into equality branches, and `b == null` is an equality.
  Firestore merges single-field indexes to serve that class, so a `served` on either is not evidence
  the target was dirty. Whether this target does merge them is exactly the sort of thing the run
  exists to observe rather than predict, so record it and read on.

Do not read `covered` in `shapes.mjs` as the expectation here. It is a prediction about the
*deployed* set — `true` for S1–S5 alike — and says nothing about which of them a bare target serves.

**Stop here, and do not deploy, on any of these.** All four are now carried by the exit status, so
a zero exit is the go-ahead rather than the first of four things to check by eye:

- a shape printing `FALSIFIES SPEC §7`, exit `1`. Read the per-variant mapping it prints rather than
  assuming a direction: the sentinel `uncovered` where a real operand is `served` is the false
  positive §2 forbids acting on; the sentinel `served` where a real operand is not is the false
  negative. Both are the claim failing, and only the mapping says which.
- `AGAINST EXPECTATION`, exit `2`. Read which direction it went, because the two mean opposite
  things. One of S1, S4, S6 or S8 answering `served` means the target was not bare, so the whole
  reading is of the covered side. S7 named in `--expect-served` and answering `uncovered` says
  nothing about the target: it is this runbook's assumption that the automatic single-field index
  serves an `a` equality with a `__name__` inequality, and that assumption failing is the finding.
- a row printing `did not enter the comparison`, exit `2`. Only `served` and `uncovered` rows are
  compared, so an `other` or an `unbuildable` shrinks a shape's operand count while the shape still
  reads `constant` — a verdict over some of the operands presented as one over all of them. Every
  line that reports a comparison prints it as `N of M`, whichever kind of row went missing, and the
  two that state a verdict over the whole shape — `constant` and `FALSIFIES SPEC §7` — add `SHORT`
  when the two numbers differ. An `UNTESTED` line carries the counts without the marker, because a
  shape that never reached a comparison is already saying the stronger thing. An `invalid` row is
  different and is *not* this: it is the backend refusing an operand it was always going to refuse,
  so it drops out of the comparison, shrinks the count, and does not fail the run. `other` and
  `unbuildable` never are. So `SHORT` says the evidence is thinner than the operand list, not that
  the run failed — the exit status says that, and a `SHORT` line beside exit `0` is an invitation to
  read how much thinner.
- a non-zero exit for any other reason: a shape `UNTESTED — only N of M operands entered the
  comparison`, or a guard refusing to run. A shape that failed on its own terms is not also reported
  `AGAINST EXPECTATION` — there is no single verdict to hold to one — so its line carries
  `expected <verdict>, not evaluated` instead, and a prediction that went unchecked is visible
  rather than absent.

In every one of them the claim the verb rests on is either false or unmeasured, the design question
is what `check` can honestly report without it, and nothing further down this runbook is worth the
wall clock until that is answered.

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

The expected reading settles here: S1–S5 and S7 served, S6 and S8 uncovered. S2 and S5 have stopped
being open questions, because the set now declares a composite that covers them either way — so
seven of the eight go into a flag.

S8 does not, and the reason is worth stating precisely, because `shapes.mjs` calls it "a field pair
the candidate set does not declare" and that is not quite right. S6 filters on `n`, which nothing
declares; S8 is `a == …` ordered by `b desc`, and `(a ASC, b ASC)` *is* declared — only the
direction differs. Whether Firestore serves that by traversing the declared index in reverse is
exactly the sort of thing this run exists to observe, and getting it wrong in a flag would stop a
correct run. So S8 is predicted here and read off the summary, not enforced.

```bash
node probe/differential.mjs indexwright-probe '(default)' \
  --expect-served S1,S2,S3,S4,S5,S7 --expect-uncovered S6 \
  > probe/differential-after.json
```

The summary reads the same way as in step 3, and so does the stop rule — the expectations have
inverted but the four conditions have not, and all four are carried by the exit status. A non-zero
exit here means stop, before reading anything below for #43 or handing ids to step 6.

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
