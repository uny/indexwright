# Changelog

All notable changes to `@indexwright/record` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows semantic
versioning. It versions independently of `indexwright`; the corpus format is versioned separately
again, by its own `corpusVersion`.

## Unreleased

### Added

- **`indexwright-record check`**, the verb [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md)
  §3 names. It replays a captured corpus against a database that already has the candidate index set
  applied, and reports the queries that come back `FAILED_PRECONDITION`. It applies nothing and reads
  only. The paragraphs below are its argument surface (issue #8); what the verb *does* with a target
  it accepted is the entry after next.

  **The target is two required flags with no fallback of any kind.** `--project` and `--database` are
  never read from `GOOGLE_CLOUD_PROJECT`, from a `gcloud config` default, or from the project inside
  application default credentials. Every one of those resolves to whatever the person running the
  command last worked against, and a database carrying more indexes than the candidate set answers
  queries the candidate set alone would not — so the wrong target does not fail loudly, it returns a
  clean report. That is the whole of issue #8. Credentials still come from ADC, as §3 relies on; what
  may not come from ambient state is *which database* is measured. Two flags rather than one resource
  path so the refusal can name the half that is missing, and because the default database is literally
  called `(default)`.

  The target is echoed to stderr on every run, not only on a failure. It is the one thing about a
  `check` run that cannot be recovered from the output afterwards, and the mistake it guards against —
  a real database in place of a throwaway one — is silent by construction. Nothing inspects the name
  for how production-like it looks: a rule that fires on `prod-sandbox` and stays quiet on `db-7`
  teaches its own silence to be read as an all-clear.

  Because that echo is what an operator is asked to trust, each half is checked against an allowlist
  — letters, digits, `-`, `_`, `.`, parentheses, and on the project half `:` — rather than against a
  list of things to refuse.

  One of the two harms behind that is present now; the other is anticipated, and the difference is
  worth stating rather than blurring. **Present:** the echo is a line of text, so a segment carrying
  a newline writes a second well-formed `indexwright-record:` line beside it naming a database nobody
  targeted, a carriage return or an escape sequence overwrites the real one in place, U+0085 and
  U+2028 are line breaks to plenty of viewers, and the bidi overrides reorder a name without altering
  a character of it. None of that depends on anything being requested.

  **Anticipated:** a segment that stops naming what it appears to name once something builds a
  request out of it. `projects/{project}/databases/{database}` assembled into a URL path is the case
  this guards against — a backslash is folded to a slash by the WHATWG parser and then resolved, so
  `throwaway\..\prod` would echo as itself and request `prod`; `.` and `..` collapse unaided; `?` and
  `#` end the path; `%2e%2e` arrives already decoded. That path is **not** the one this version
  takes: the client is now a dependency, and it sends the resource name as a protobuf string field
  over gRPC with no URL parser anywhere near it, so the server rejects these rather than resolves
  them. The allowlist refuses them regardless, which costs nothing and stops the guard from being a
  function of a transport that could change under it.

  The allowlist is deliberately **wider** than Google's rules for either half — both are lowercase
  alphanumerics and hyphens, plus the literal `(default)` — which is the property a blacklist was
  trying to buy: a validator that is merely close refuses valid targets, and for a required argument
  with no fallback that leaves no way to proceed. Being looser than the real rules keeps that while
  making the answer to "what else gets through" be nothing. The colon is why the two halves are not
  the same set: a legacy domain-scoped project id is spelled `google.com:my-app`, while the database
  is the last segment before a `:customMethod` suffix, where a colon could name an operation instead.

  A value beginning with `-` is refused separately and named as a missing value rather than a
  malformed one, on both the target halves and the file paths: `--database --corpus` is an option
  absorbed because the one before it was written without its argument, not a database called
  `--corpus`. `--help` and `--version` are answered while walking the arguments rather than by
  scanning them ahead, so that one sitting where a value belongs is that same missing value — scanned
  ahead, `check --database --version` printed the version and exited 0, a success for a command line
  that named no database.

- `--corpus` and `--indexes` on `check`, defaulting to `firestore.queries.json` (what `record` writes)
  and `firestore.indexes.json`.

- **The verb body** — readiness, then reconciliation, then replay, each one a gate rather than a
  step. `check` reads the corpus and the candidate declarations first, before it constructs anything,
  because everything up to the first client is offline and everything after it costs a settling
  period at the least; a mistyped path is then found on the near side of that minute. It then polls
  the Admin API until `ReadinessGate` says the set has been quiet long enough, reconciles the listing
  it settled on against the candidate file, and only then replays. A run that cannot settle one of
  those questions declines and says which — it does not fall back to replaying against a set it
  cannot vouch for, which is the quietly-wrong behaviour §3 exists to rule out.

  **Exit `1` is the finding and exit `2` is the absence of one.** Unlike `lint`, which defaults to
  exit `0` even with findings because its rules have unmeasured false-positive rates, the oracle here
  is Firestore itself — so a `FAILED_PRECONDITION` is worth failing a pipeline on. `2` covers every
  way the run could not answer, and it outranks `1`: a report missing entries is not a clean report
  with a caveat, and an operator who sees `1` should be able to read it as "these and no others".
  An entry that cannot be replayed, an `INVALID_ARGUMENT`, and a status the run cannot interpret all
  land there and are named out loud, because SPEC §7 reports `FAILED_PRECONDITION` and never the
  others: an invalid replay is a defect in this tool or in the test that issued the query, not a
  statement about the index set.

  Replay materialises SPEC §7's plan against the SDK and adds nothing to it. There is no `limit` and
  no `select`: the corpus records neither, and if either narrowed index selection the cost would be a
  query served that should have failed — a false clean verdict, which §2 forbids more strictly than a
  false alarm. A wire field path that this version cannot convert into the SDK's own is refused as
  un-replayable rather than approximated, because the approximation filters on a *differently named
  field* and reports a `FAILED_PRECONDITION` for a query nobody issued.

- **Both clients are released, on every path out** (issue #39). The gRPC stub is lazy, so the channel
  appears on the first call and then refs the event loop — a `check` that listed and reported would
  have printed its report and never exited, which is a worse failure for a CI step than one that
  errors. `IndexLister` gains `close` in its `Pick`, which is the other half of the issue: narrowed
  to `listIndexesAsync` alone, a caller had no typed way to release the channel even if it wanted to,
  and the JavaScript API is public. `listLiveIndexes` still does not close — readiness is established
  by observing the same set at least twice, so a lister that closed itself would build and tear down
  a channel per poll. The verb closes the lister before it builds the replay client, so at most one
  channel is open at a time.

- **The Firestore Admin adapter** — `listLiveIndexes`, `adminLister`, `indexesParent`, `AdminError` —
  which asks a database for its composite indexes and hands the listing to `ReadinessGate` and
  `reconcile`. It is one call to `projects.databases.collectionGroups.indexes.list`, across every
  collection group at once, and it classifies nothing: an unrecognised state, a numeric enum, an
  unreadable field are all conveyed to the modules whose job it is to decline on them. What it does
  own is the difference between *listed and empty* and *could not list* — a failure leaves it as an
  `AdminError` and never as an empty array, because `[]` means "observed, and empty" to everything
  downstream. `listIndexesAsync` follows the page tokens, so a partial listing cannot be mistaken
  for a set.

  This adds the package's first non-repository runtime dependency, `@google-cloud/firestore`, which
  covers both the admin client and the replay client to come. It is loaded lazily, on the one path
  that constructs a client: importing `@indexwright/record` for `parseCorpus` does not pay for a
  Firestore SDK it never touches.

- **`check` refuses to run at all while a redirect variable is set**, with no override (issue #37).
  This is the other half of issue #8 rather than a separate concern. `FIRESTORE_EMULATOR_HOST` is the
  first of the two; `GOOGLE_CLOUD_UNIVERSE_DOMAIN` is the second, and is described below. The data
  client honours the emulator variable unconditionally, whatever project and database it was
  constructed with — so with it
  exported, `check` would announce the real database it was given, send every query to the local
  emulator, and, because an emulator enforces no composite index at all, report that the candidate
  set covers everything. The wrong answer arrives as a *clean report* rather than as an error, which
  is exactly what #8 was about; #8 closed the case where the target is inferred, and this closes the
  one where it is named correctly and then quietly not used. It is not a contrived setup:
  `indexwright-record` exports the variable into the suite it runs, and it lives in plenty of shell
  profiles.

  There is no `--allow-emulator`, because replaying against an emulator cannot answer the question
  `check` asks. The refusal comes after the target is read, so the message can name the database that
  would have been announced and not measured, and the value is escaped the same way the target is —
  it prints beside the line naming the target, so a value that forges a line would forge one. The
  same refusal guards the adapter itself, for callers reaching the JavaScript API directly — reading
  `process.env`, which is the source the client reads, rather than an environment passed in: a guard
  that consults a different source than the thing it guards can disagree with it, and this one did.

  **`GOOGLE_CLOUD_UNIVERSE_DOMAIN` is refused on the same terms**, and finding it is the reason this
  entry does not claim completeness the way an earlier draft did. That draft said the emulator
  variable was the only one, having measured `@google-cloud/firestore` — which reads three variables,
  the other two choosing a transport and a diagnostic. It measured the wrong package. `check` lists
  indexes through `v1.FirestoreAdminClient`, which lives in `@google-cloud/firestore-api` and does
  not read the emulator variable at all; what it reads is `GOOGLE_CLOUD_UNIVERSE_DOMAIN`, which it
  turns into `firestore.{value}` as its service path. `google-gax` does validate a universe domain,
  but against its own default rather than against the path the client already built, so an ordinary
  ADC credential matches and nothing objects. The listing then arrives from another service under the
  announced target's name — the same clean-report failure, by a second route.

  Other variables in the dependency tree are deliberately *not* refused, and the source comment now
  carries the worked list. The property that decides membership is whether a variable can *silently
  change which backend answers* — not whether it touches the client at all. Credentials come from
  ADC because SPEC §3 says so; the project variables never reach the resource, because
  `listIndexesAsync` sends the `parent` it is given verbatim; and the mTLS variables reach
  `firestore.mtls.googleapis.com`, which is Google's Firestore answering for the same database.

  No count is claimed here, deliberately. Two earlier drafts of this entry gave one and both were
  wrong — the first by surveying `@google-cloud/firestore` when the admin client lives in
  `@google-cloud/firestore-api`, the second by undercounting the tree by roughly seven. A rule that
  can be re-applied is worth more than a list that silently rots.

### Changed

- **`reconcile` declines a live field that carries no usable path**, where it previously keyed one.
  A live entry whose field arrives with `fieldPath` missing, `null`, or empty is now
  `field-unreadable` and the verdict is `indeterminate`; before, `canonicalFields` rendered the
  missing path as the literal string `undefined`, so any two such fields keyed alike and a
  declaration for a field genuinely named `undefined` could be vouched for by an index that was not
  it. The declared side already refused these at parse time, so this closes the live half of a guard
  that was only ever half applied. A caller upgrading sees a previously vouched set become
  `indeterminate` only if its listing carried such a field, which a real Admin API listing does not.

  `UnreadableIndex.detail` for that reason is now the offending element serialised, rather than
  `String(field?.fieldPath ?? field)` — which rendered a pathless object as `[object Object]` and an
  empty path as nothing at all.

## [0.4.0] — 2026-08-15

Minor rather than patch, because both ends of the capture proxy are now constrained and the case that
constrains is a legitimate one: an emulator reached by container name is not loopback, and a run that
worked in 0.3.0 needs `--allow-remote-emulator` to keep working. Calling that a patch would be a lie
about what an upgrade costs.

`check` is still not in this release. What lands here is the part of it that needs no Firestore
client — `reconcile`, the presence half of what [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md)
§3 requires the verb to settle — plus two fixes to `indexwright-record` itself. Its comparison of a
candidate index set against a live listing is now exercised against a listing a real database
returned, rather than only against ones written by hand.

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

  **The classification is literal and resolves nothing**, which bounds what the guard is worth.
  `localhost` counts as loopback because of how it is spelled — normalised first for case, a trailing
  dot, brackets, and surrounding whitespace — so a resolver that answers it with something else — DNS
  consulted ahead of files, an image without `/etc/hosts`, a corporate wildcard domain — passes the
  check while the connection leaves the machine. In the other direction, a name that is loopback on
  the machine in question but is spelled otherwise, such as `foo.localhost` or `ip6-localhost`, is
  refused. The address is the remedy that stays correct: neither of those names is loopback by
  construction — RFC 6761 only recommends the first, and the second is a line in a distribution's
  `/etc/hosts` — so `--allow-remote-emulator`, or `allowRemoteBind: true` at the bind end, admits the
  name without establishing where it points. Being spelling-bound cuts both ways, so the address has
  to be written in a spelling the check knows: a dotted quad in `127.0.0.0/8`, `::1`,
  `0:0:0:0:0:0:0:1` and IPv4-mapped forms are recognised, while `0::1` and `127.1` are loopback to a
  resolver and `remote` here — [issue #27](https://github.com/uny/indexwright/issues/27).

  Resolving instead of reading is [issue #24](https://github.com/uny/indexwright/issues/24) and is a
  design change rather than a patch — `parseArgs` refuses before it returns, and `classifyHost` and
  `isLoopbackHost` are exported as synchronous predicates, so the refusal happens before anything is
  opened. (What lets the message name where the address came from is separate from that: `parseArgs`
  tracks whether the value was typed or inherited and passes it along.)

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
  interrupts. `SIGINT` and `SIGTERM` are now handled for as long as the suite is running: the suite
  is awaited rather than killed out from under itself, so its own cleanup runs, and once it has
  exited the corpus is written by the same path any other exit takes. The run
  then reports `128 + signal` — 130 for `SIGINT` — whatever the suite made of the signal, since a
  suite that traps it and exits 0 did not turn an interrupted run into a successful one. A second
  interrupt is not queued behind the first: the handlers are removed when the first arrives, so
  pressing Ctrl-C again meets Node's default and stops the recorder at once rather than waiting on a
  suite that may not be going to exit.

  The suite is sent the signal only when it did not already have it. A terminal delivers `SIGINT` to
  the whole foreground process group, which the suite is in, so on a terminal it has its own copy
  and a forwarded second one would be read by `vitest`, `mocha` and others as "quit now" — cutting
  short the very cleanup this change exists to let them finish, and making Ctrl-C behave worse under
  `indexwright-record` than without it. What counts as "on a terminal" is whether the process has a
  controlling terminal, not whether its streams are ttys: a run whose output is redirected still has
  one, and still had its Ctrl-C delivered to the group.

  `SIGTERM` is always passed on. No terminal generates one, and declining would lose the case it
  usually is — a supervisor or a container runtime signalling this process alone, which nothing else
  will pass on. A process manager that signals the whole group instead, as systemd does by default,
  does hand the suite a duplicate; nothing at delivery time tells the two apart.

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

[0.4.0]: https://github.com/uny/indexwright/releases/tag/record-v0.4.0
[0.3.0]: https://github.com/uny/indexwright/releases/tag/record-v0.3.0
[0.2.0]: https://github.com/uny/indexwright/releases/tag/record-v0.2.0
