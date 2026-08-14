# Changelog

All notable changes to `@indexwright/record` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows semantic
versioning. It versions independently of `indexwright`; the corpus format is versioned separately
again, by its own `corpusVersion`.

## Unreleased

### Changed

- **`indexwright-record` now refuses to forward to an emulator that is not on this host**, and
  `startCapture` refuses to bind an address other than loopback. Both were previously unconstrained
  (issue #7). The proxy authenticates nothing and forwards verbatim, so a non-loopback upstream routes
  whatever documents and gRPC `authorization` metadata it holds through this process, and a
  non-loopback bind is an open read/write channel into the emulator's dataset for anyone who can reach
  the port. The upstream is the half that arrives on its own: `FIRESTORE_EMULATOR_HOST` is read from
  the environment, so a run can inherit an address nobody typed, and the refusal names which variable
  is responsible for exactly that reason.

  **This is a breaking change**, and the case it breaks is a legitimate one: an emulator reached by
  container name, as in a compose file, is not loopback. Pass `--allow-remote-emulator` (or
  `allowRemoteUpstream: true`) to proceed. `indexwright-record` gained no way to change the bind
  address — adding a `--host` in order to guard it would have been inventing the exposure — so the
  bind refusal can only be reached through the JavaScript API, where `allowRemoteBind: true` states
  the intent.

  A wildcard is treated differently at the two ends, because it means opposite things there. Bound,
  `0.0.0.0` is every interface and is refused. Connected to, it is *this host* — the kernel sends it
  to the local machine — so `FIRESTORE_EMULATOR_HOST=0.0.0.0:8080`, which is what a compose file
  tends to leave behind, is a local emulator and passes without the override. Refusing it would have
  refused a purely local run while telling the reader it was not on this machine, and the remedy it
  offered was to permit remote emulators.

- **`close()` now destroys a pending upstream connection.** It previously called `close()` on the
  upstream session, which is a graceful shutdown and does nothing for a TCP connection that has not
  been established yet — and `session.socket` is a guarded Proxy that refuses `destroy`. The socket
  therefore survived and held the event loop open until the OS gave up on the connect, 75 seconds on
  macOS. That is precisely the state a run pointed at an unreachable emulator ends in, so the symptom
  was `indexwright-record` appearing to hang *after* a capture that had already written its corpus.
  The socket is now created by this package rather than by `http2.connect`, which is the only way to
  get a reference that can be closed.

- `parseHostPort` moved to a new `endpoints` module so the argument parser and the proxy read an
  address with one set of rules rather than two. It is still exported from the same place.

- **This release takes a runtime dependency on `indexwright`**, as §3 said it would when `check`
  arrived: reconciliation needs the linter's index model and the canonical key, so that both sides
  are compared under one interpretation rather than a second copy of it. The direction stays one-way
  — `indexwright` acquires no runtime dependency, in any version.

  The range is `>=0.2.0 <1`, not a caret. A caret on a `0.x` version pins the minor, so the next
  linter release would stop satisfying it — and since the two are released together, that is not a
  hypothetical. What made it worth avoiding is that nothing would have *said* so: the workspace link
  would quietly give way to a registry fetch, and `npm ci`, the test suite, and the tarball check
  would all go on passing against a copy of the linter that is not the one being released. A single
  `0.x` range also lets an adopter who depends on `indexwright` directly resolve one copy rather than
  two, which matters because `reconcile` takes `AnalysedIndex` values their `analyse` produced.

### Added

- Reconciliation of a candidate index set against the set a database actually holds, the presence
  half of what [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md) §3 requires `check` to
  settle before it reports. `reconcile` compares the two sides under the canonical index key of §5,
  so the trailing `__name__` a live index always carries and a declaration usually omits does not
  read as a difference, and returns `identical`, `diverged`, or `indeterminate`. Both directions of
  divergence corrupt a report: an undeclared index on the target serves queries the candidate set
  alone would fail, so the run comes back clean and the gap never appears in the output, while a
  declared index the target lacks produces the false `FAILED_PRECONDITION` §2 forbids acting on. An
  entry whose canonical form cannot be derived makes the whole result `indeterminate` rather than
  being guessed at or dropped, because §3 requires `check` to decline rather than vouch for a set it
  cannot vouch for. No client and no I/O: it is fed an analysed document and an observed listing.

  What it compares is exactly §5's key — collection group, query scope, fields. A set that turns on
  anything else is refused rather than matched on the key that ignores it: a `density`, which decides
  which documents an index covers and which §4 passes through unanalysed, or a Datastore-mode
  `apiScope`. Both are refused on whichever side declares them — the live side through `unreadable`,
  the candidate side through the new `incomparable` — because matching on the key alone would vouch
  for a `DENSE` live index against a `SPARSE_ANY` declaration.

### Fixed

- **Ctrl-C during a suite no longer loses the corpus** (issue #10). `indexwright-record` runs the
  suite with inherited stdio, so an interrupt reaches the whole foreground process group and the
  recorder with it; nothing handled it, so Node's default terminated the recorder on the spot, before
  the capture was closed and before the corpus was written. Everything the proxy had observed was
  discarded — on a long suite, the entire point of the run, and a long suite is when someone
  interrupts. `SIGINT` and `SIGTERM` are now handled for as long as the suite is running: the signal
  is passed to the suite rather than the suite being killed out from under itself, so its own cleanup
  runs, and once it has exited the corpus is written by the same path any other exit takes. The run
  then reports `128 + signal` — 130 for `SIGINT` — whatever the suite made of the signal, since a
  suite that traps it and exits 0 did not turn an interrupted run into a successful one. A second
  interrupt is not queued behind the first: the handlers are removed when the first arrives, so
  pressing Ctrl-C again meets Node's default and stops the recorder at once rather than waiting on a
  suite that may not be going to exit.

## [0.3.0] — 2026-08-13

The parts of the v0.3 coverage check that are decidable without a Firestore client. The `check`
verb itself is not in this release: nothing here executes a query or talks to a database, and
`indexwright-record` captures exactly what it captured in 0.2.0.

### Added

- Replay synthesis, specified in [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md) §7
  (*Replay without values*): `planReplay` turns a corpus entry back into a plan for the query v0.3's
  `check` has to issue. A corpus holds no values, so replay invents them; this decides only what
  *kind* of operand each filter needs — `scalar` or `reference`, and its arity — which follows from
  the operator and the field path and never from a value. It builds no Firestore objects and imports
  no client, so the two synthesis mistakes that would make `check` report `INVALID_ARGUMENT` instead
  of the `FAILED_PRECONDITION` §7 requires — a wrong-shaped operand, an empty `where` — are settled
  where they can be tested exhaustively; materialising the plan against a real collection is the
  adapter's job. An entry with no replayable form — a childless root `OR`, or a childless composite
  below the root, both of which a committed corpus can carry — raises `ReplayError` rather than a
  plan for a wider query than the one recorded. Exported alongside it: `isReplayComposite`,
  `NAME_FIELD`, `operandFor`, `ReplayError`, and the `Operand`, `OperandType`, `ReplayComposite`,
  `ReplayLeaf`, `ReplayNode`, `ReplayPlan` types.
- A readiness gate for the index set under test (SPEC §3, *v0.3 — coverage check*): `ReadinessGate`,
  with `DEFAULT_SETTLE_MS`, `INDEX_STATES`, `isReportable`, `isTransient`, and the `IndexState`,
  `LiveIndex`, `Readiness` types. A composite index answers `FAILED_PRECONDITION` for a period after
  it can already serve some queries, so one succeeding query is not evidence that a sibling will
  succeed; reporting inside that window emits exactly the false positive §2 forbids. Readiness is
  therefore established twice over — every index reports `READY`, *and* the set has been quiet for a
  settling period, which a single observation can never satisfy. The gate holds no client and does
  no I/O; it is fed observations and a monotonic clock, so the rule is testable without waiting on a
  real index build. `DEFAULT_SETTLE_MS` (60s) is a conservative guess, not a measured bound, and
  errs long on purpose.

### Notes

- **Both additions are provisional and have no caller yet.** They are the parts of v0.3's `check`
  that are decidable without a Firestore client, written and tested ahead of the verb itself, so
  their shape has not been exercised by a real consumer. The package's JavaScript API is already
  unstable before 1.0 — `corpusVersion` is the contract, not the API — and these two are the least
  settled corner of it. Expect them to move when `check` lands.

## [0.2.0] — 2026-08-10

First release. Query capture, specified in [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md) §7.

### Added

- `indexwright-record [options] -- <command>` runs a suite with `FIRESTORE_EMULATOR_HOST` pointed
  at a pass-through proxy in front of the Firestore emulator, and writes the query shapes it
  observed to `firestore.queries.json`. The exit code is the suite's, so a failing suite still
  fails, and the corpus is written either way. The emulator does not enforce composite indexes, so
  a green run says nothing about whether the queries it issued are indexed; the corpus is what
  `check` replays in v0.3 to answer that.
- A corpus records shape only: collection, scope, filter tree, sort order. Values, project and
  database, `limit`, `offset`, cursors, `select`, and occurrence counts are all left out. Two
  spellings of one query collapse to one entry, so the file is stable across runs.
- Everything the proxy declines is counted under a closed vocabulary and reported on stderr —
  `listen-query`, `aggregation-query`, `partition-query`, `vector-query`, `unsupported-shape`,
  `unsupported-rpc`, `unsupported-encoding`, `undecodable-message`. A query that was issued and
  then discarded without trace would look like coverage.
- A provisional JavaScript API for building, writing, and reading a corpus. `corpusVersion` is the
  stable contract; the API and the CLI flags are not, before 1.0.

### Notes

- **No runtime dependencies.** Capture turned out to need no gRPC stack: a transparent proxy is
  `node:http2`, and the closed operator vocabulary of §7 requires an in-tree enum table whichever
  library reads the bytes. This is not a promise for every version — `check` will need a Firestore
  client.
- **The proxy is meant to be invisible.** Bodies, trailers, and trailers-only gRPC errors are
  forwarded untouched, and HTTP/1.1 connections are told apart by the connection preface and
  forwarded rather than refused, so that the emulator's REST endpoints keep working. Verified
  against the real emulator: client behaviour through the proxy matches client behaviour without
  it, on the success path and on `INVALID_ARGUMENT`.
- **Known gaps, named rather than hidden.** Queries issued through the Firebase Web SDK travel by
  WebChannel over HTTP/1.1 and carry no gRPC to read; those requests are forwarded and reported on
  stderr. Snapshot listeners carry their query over `Listen` and are counted, not recorded.
  Capturing `Listen` is the first extension worth making.

[0.3.0]: https://github.com/uny/indexwright/releases/tag/record-v0.3.0
[0.2.0]: https://github.com/uny/indexwright/releases/tag/record-v0.2.0
