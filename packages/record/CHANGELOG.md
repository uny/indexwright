# Changelog

All notable changes to `@indexwright/record` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows semantic
versioning. It versions independently of `indexwright`; the corpus format is versioned separately
again, by its own `corpusVersion`.

## Unreleased

### Added

- Replay synthesis, specified in [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md) §7
  (*Replay without values*): `planReplay` turns a corpus entry back into the query v0.3's `check`
  has to issue. A corpus holds no values, so replay invents them; this decides only what *kind* of
  operand each filter needs — `scalar` or `reference`, and its arity — which follows from the
  operator and the field path and never from a value. It builds no Firestore objects and imports no
  client, so the two synthesis mistakes that would make `check` report `INVALID_ARGUMENT` instead of
  the `FAILED_PRECONDITION` §7 requires — a wrong-shaped operand, an empty `where` — are settled
  where they can be tested exhaustively. Exported alongside it: `isReplayComposite`, `NAME_FIELD`,
  `operandFor`, `ReplayError`, and the `Operand`, `OperandType`, `ReplayComposite`, `ReplayLeaf`,
  `ReplayNode`, `ReplayPlan` types.
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

[0.2.0]: https://github.com/uny/indexwright/releases/tag/record-v0.2.0
