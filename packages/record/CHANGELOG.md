# Changelog

All notable changes to `@indexwright/record` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows semantic
versioning. It versions independently of `indexwright`; the corpus format is versioned separately
again, by its own `corpusVersion`.

## [Unreleased]

### Fixed

- **`unique`, `multikey` and `shardCount` are refused rather than vouched for** (issue #30). All
  three are invisible to SPEC §5's canonical key, and unlike `density` they were refused on neither
  side of `reconcile`: a live index that had one was matched on a key that could not see it, and so
  was a declaration that went out of its way to ask for one, so two sets differing in exactly that
  respect came back `identical` and `check` vouched for them. They now take the route `density`
  already takes — the live side through `unreadable`, the candidate side through `incomparable`,
  either making the verdict `indeterminate` — with `unique-unrecognised`, `multikey-unrecognised`
  and `shard-count-unrecognised` added to `UNREADABLE_REASONS` and `INCOMPARABLE_REASONS`. Absent
  and the proto3 default written out (`false`, `0`) are comparable, since both mean what a
  declaration without them means; anything else, including the default arriving as a string, is
  refused. The same guard is applied to field overrides, which are beyond the issue's text but not
  its reasoning: `fields.list` nests the same `Index` proto, the admin client fills the three in on
  every nested index, and refusing them on composite indexes alone would be half a guard.
  `FIELD_UNREADABLE_REASONS` and `OVERRIDE_INCOMPARABLE_REASONS` gain the same three members.
  `LiveCompositeIndex` and `LiveSingleFieldIndex` model the three fields.
- **`check` declines on an index that regressed or was re-created while the queries were being
  answered** (issue #50). The confirmation #49 added after replay reconciles declarations only:
  `reconcile` does not consult `state` and keys on fields rather than on the resource name, so an
  index that fell back to `CREATING` or `NEEDS_REPAIR` mid-run, or one deleted and re-created under
  a new name with the same fields, reconciled as `identical` and the `FAILED_PRECONDITION` it caused
  was reported as a coverage gap — exit 1 for a gap the candidate set does not have. The second
  listing is now also compared with the one the readiness gate settled on, over the same flattened
  set the gate observes (composites and the overrides' nested indexes): every index must still be
  `READY`, and the set of resource names must be the same. Either failing withdraws the verdict
  (exit 2) with a line naming what changed, in the gate's own words for a regression. No extra
  listing and no second settling period; the trade #49 declined to make is not made here either.

### Changed

- `UnreadableReason`, `IncomparableReason`, `FieldUnreadableReason` and `OverrideIncomparableReason`
  widen by the three members above. An exhaustive `switch` or `Record` over any of them stops
  compiling until it names them.
- `stillHeld` and `Held` are exported from the readiness module: the second look at a settled set,
  as a pure function over two observations, so the rule is testable without an index build.

### Notes

- `shardCount` is refused on §3's rule rather than on an observation. Whether a sharded index serves
  the same queries as an unsharded one has not been measured; if it does, refusing it manufactures an
  `indeterminate` for a set that really is the candidate set, and the member should move to
  comparable. Until a listing shows that, declining is what §3 asks for. On the database kind this
  release targets the live side always returns `0`, so the refusal is reachable only from a
  declaration that writes it.
- The live half is guarded on the model, not measured: the Enterprise and MongoDB-compatible
  listings issue #20 could not reach are still unobserved. A non-null `searchIndexOptions` under
  `ANY_API` — the fourth route the fixture notes mention — is not modelled and not refused.
- What the second look cannot see is a change that began and finished inside the window. A composite
  index is named by a server-generated id, so a re-create always changes the name and is caught even
  once it is `READY` again. An override's nested index is not: it is named here from field, scope and
  direction, so one dropped and re-applied that reached `READY` before the confirmation reads as
  held. Seeing that would take the gate's polling through the window, which is the cost #50 chose
  not to pay.

## [0.8.0] — 2026-09-21

The release that closes the gap 0.2.0 named on its first day. Coverage was bounded by what reaches
the proxy as `RunQuery`, and a snapshot listener never does: its query rides on a `Listen` stream,
which 0.2.0 through 0.7.0 counted once as `listen-query` and recorded nothing from. A suite whose
only exercise of a collection was `onSnapshot` produced a corpus with no entry for it, and `check`
then reported coverage it had never measured. This release reads the query each `Listen` target
carries, under the rules `RunQuery` already had, and without waiting for a stream that may never
end. The corpus format does not move; the reason `listen-query` is retired from what the recorder
writes and kept in what it reads.

### Added

- **`Listen` is captured** (issue #6). A snapshot listener carries its query in
  `Target.QueryTarget.structured_query` and issues no `RunQuery`, so a suite whose only exercise of
  a collection was `onSnapshot` produced a corpus with no entry for it, and `check` then reported
  coverage it had never measured. The proxy now reads each `add_target` on a `Listen` stream under
  the same shape rules as a `RunQuery`, frame by frame as the bytes arrive rather than when the
  stream ends — the stream is bidirectional and lives as long as the listener does, and a listener
  the suite never detaches has a stream that never ends. A target re-sent after a reconnect
  collapses onto the same key; a `remove_target`, or a target naming documents rather than a query,
  is control traffic and is neither recorded nor counted. `Listen` and `RunQuery` entries are not
  distinguished in the corpus (their index requirements are the same), so `corpusVersion` stays
  at 2.

### Changed

- **`listen-query` is no longer a skip reason the recorder produces.** It leaves `SKIP_REASONS` and
  the `SkipReason` type; `LEGACY_SKIP_REASONS` and `LegacySkipReason` name it as a reason a corpus
  may still carry, and `parseCorpus` / `mergeCorpora` accept it, so a corpus committed under an
  earlier release reads as it did. `Corpus.skipped` widens to `(SkipReason | LegacySkipReason)[]`.
- `classify` reports `{ kind: 'record', method: 'RunQuery' | 'Listen' }` for a captured method,
  where it reported `{ kind: 'record' }` before.
- The barrel exports `decodeListen`, `FrameSplitter`, and `Frame`.

### Notes

- **`Listen` and `RunQuery` are one entry.** Decided rather than left open: their index
  requirements are the same, so the corpus does not say which carried a query, and `corpusVersion`
  stays at 2. A consumer that needs the distinction is the observation that would reopen it, and
  it would be a format bump.
- **The remaining capture gap is the transport.** A suite driven through the Firebase Web SDK
  talks WebChannel over HTTP/1.1 and carries no gRPC to read; `indexwright-record` still counts
  those requests on stderr and records nothing. SPEC §3 names it as the one implementation gap
  left.

## [0.7.0] — 2026-09-21

The release that closes the half of the index set `check` was not reading. Since 0.5.0 the verb
has established readiness and reconciled the target against the candidate file, in both directions
and twice per run — against `collectionGroups.indexes.list` alone. Single-field configuration is a
different resource, `collectionGroups.fields`, and it decides which replayed queries succeed as
surely: a collection-group query on one field is served only by an override declaring that scope,
and an exemption removes the automatic indexes a query with no composite index relies on. This
release lists it, gates it, and reconciles it, on the canonical override key `indexwright` 0.3.0
gives each declaration; that dependency is what moves the range. `IndexLister` gains a member, which
is the one change here that breaks a consumer's fake. `indexwright-record` still captures exactly
what it captured in 0.2.0.

### Added

- **`check` reconciles `fieldOverrides` against the target, and waits on them** (issue #53). The
  index set has two halves, and `check` read one. Single-field configuration —
  `collectionGroups.fields` on the API, `fieldOverrides` in the file — decides which replayed
  queries succeed as surely as composites do: a collection-group query on one field is served only
  by an override declaring that scope, and an exemption removes the automatic indexes a query with no
  composite index relies on. So both failure modes SPEC §3 names arrived by a route `check` was not
  looking at, and the confirmation at the end of the run did not see them either. Now every
  readiness poll lists fields beside indexes, under the filter the Firebase CLI's
  `firestore:indexes` uses (`indexConfig.usesAncestorConfig=false OR ttlConfig:*`, so a declaration
  the CLI wrote for a TTL-only field reconciles rather than reading as missing); the nested
  single-field indexes go through the gate, so an override still building is waited on; and both
  halves are reconciled in both directions before replay and again after it, on the canonical
  override key `indexwright` 0.3.0 gives each. An exemption is named in the gate's fingerprint too
  (`<field>#exempt`), so one applied between two polls restarts the settling period as a new index
  would; a field whose `indexConfig` is `reverting` is waited on before replay and refused after it;
  and a field inheriting an empty set from a collection-level exemption (`<group>/*` with no
  indexes, which the CLI exports beneath a TTL field as `ttl: true, indexes: []`) is read as the
  exemption it inherits, when — and only when — that ancestor is in the same listing saying so. `__default__/*` is recognised by name and checked
  against the three documented indexes rather than compared; a database whose default differs is
  declined on, since the override model assumes it. `ttl` is compared on neither side. New on the JS
  API: `listLiveFields`, `FIELDS_FILTER`, `reconcileOverrides`, `liveSingleFieldIndexes`,
  `DEFAULT_COLLECTION_GROUP`, `DEFAULT_FIELD_PATH`, `FIELD_UNREADABLE_REASONS`,
  `OVERRIDE_INCOMPARABLE_REASONS`, and the `LiveField` / `OverrideReconciliation` family beside
  `Reconciliation`. `isVouched` now accepts either reconciliation.

### Changed

- **`IndexLister` gains `listFieldsAsync`**, for the listing above. A fake of the type must now
  yield fields as well as indexes — `(request: { parent; filter }, options?) => AsyncIterable<object>`
  — or `check` declines on its first poll (`readiness could not be established`, exit 2), since the
  `TypeError` of a missing method is wrapped like any other listing failure. The real client
  satisfies it unchanged. The dependency on
  `indexwright` moves to `>=0.3.0 <1`, which is where `analyseOverrides` and the override key live.

- **`IndexLister` is declared structurally, and no longer names a package this one does not
  control** (issue #40). It was a `Pick` of `@google-cloud/firestore`'s admin client, whose method
  signatures are generated in `@google-cloud/firestore-api` — a transitive 0.x dependency whose
  range the data client moves at a minor of its own. Re-exported, that meant a consumer's fake
  typechecked against whichever `firestore-api` *their* install resolved, so a `@google-cloud/firestore`
  minor could break the typecheck of a project whose `@indexwright/record` had not changed, and this
  package's lockfile would never see it. The type is now the two members `listLiveIndexes` calls,
  with the request and options narrowed to the fields it sends, so it is governed by this package's
  semver alone; the real client is pinned against it inside `adminLister` at compile time, which is
  where the drift-safety the `Pick` bought now lives. What is visible from outside: `listIndexesAsync`
  yields `object` rather than the generated `IIndex`, which is what `listLiveIndexes` always treated
  it as, so a fake that yields index-shaped objects still typechecks, while a caller that derived a
  type from the old element type must name it themselves; the request is now exactly `{ parent }`
  and the options exactly `{ autoPaginate? }`, so a caller that passed the client other fields
  through an `IndexLister` (`pageSize`, `filter`, a `timeout`) must hold the client itself, and a
  fake whose parameters were narrower than those (a required field beyond `parent`) no longer
  satisfies the type.

### Notes

- **`test/fixtures/live-indexes.json` can be re-observed** (issue #29). The fixture recorded the
  command that created its index and nothing about how the three renderings were read back, so the
  first refresh would have turned a listing a real database returned into a hand-edited file.
  `scripts/capture-live-indexes.mjs` now does the reading: it tries the three creations a standard
  native database refuses and records each refusal verbatim, lists through the admin client over
  gRPC and over `fallback: true` and stops if the two disagree, lists through `gcloud` and the
  Firebase CLI, and writes the renderings and a `source` naming every command and version. The
  prose `observations` stay a maintainer's, as the expected shapes do for `capture-fixtures.mjs`.
  Run by hand against the disposable project, never in CI. The fixture is the 2026-09-20 capture:
  it now carries the `searchIndexOptions: null` the observations already described, and `source`
  names the client versions and every command. Not a change to the package.
- **`test/fixtures/live-fields.json` is its sibling** (issue #53), captured by
  `scripts/capture-live-fields.mjs`, which configures three fields of a probe collection group — an
  override with a collection-group scope through the admin client's `updateField` (`gcloud`'s
  `--index` cannot name a scope), an exemption through `gcloud`, and a TTL-only field — waits for
  them, and reads the listing back through the admin client (twice), `gcloud`, and the Firebase CLI.
  Two of the three claims `overrides.ts` rests on are now read from it rather than remembered: the
  default lists under `__default__/*` with the three documented indexes, and an exemption arrives
  with no `indexes`. The third — that a TTL-only field arrives with the inherited set materialised —
  is not: TTL is a billed feature and the disposable project has no billing, which the script
  records verbatim and the fixture's `observations.ttlNotObserved` says out loud. Also read from it:
  a nested index carries `DENSITY_UNSPECIFIED` where a composite carries `SPARSE_ALL`, which is why
  `COMPARABLE_DENSITIES` holds both.
- **The rules for an inheriting field are read from the Firebase CLI's source, not yet from a
  listing.** What `check` does with a field that carries a TTL and inherits its indexes — expects
  the inherited set materialised, accepts the ancestor's `*` as the field's own path there — is
  what the CLI's `firestore:indexes` reads from the same listing, and the fixture above could not
  observe it. A wrong expectation there declines every run against a database with a TTL field
  rather than misreporting one, which is the safe direction; it is the first thing to re-observe
  when a billed probe is available.
- **#50 ships open, as it did in 0.6.0.** The second listing now covers both halves, and neither
  keys on `state`.

## [0.6.0] — 2026-09-13

The release that makes `check` adoptable. 0.5.0 shipped the verb; this release is what it takes to
adopt it, in four parts. A project that already has gaps can
start with `--baseline` and be told about new ones only. An index set queried by more than one
suite can be checked against all of their corpora at once, as the one set it is. A corpus now
records who produced it, echoed beside the target on every run and — with `--require-identity` —
refused when absent, so a file nobody regenerates stops looking like a current one. And a replayed
query reads one document rather than the collection it names, which is what it costs to run on
every push. The corpus format moves to `corpusVersion` 2 for the producer, and version 1 stays
readable; `CheckCommand.corpus` becomes a list, which is the one change here that breaks a caller
of the JS API.

### Added

- **`check --corpus` is repeatable, and the corpora are checked as one set** (issue #56). One index
  set is routinely consumed by more than one suite — several packages in a workspace, or several
  services in separate repositories sharing one database — and each suite's corpus is a partial view
  of what queries the set. Checking them one at a time answers a narrower question than the set poses:
  a run says "this corpus is covered", and a set can satisfy every corpus checked while failing the
  one that was not. That is the ordinary shape of the failure this tool exists to catch, because the
  declaration and the query that needs it are frequently not in the same place — and the consuming
  suite whose capture did not run is exactly the one whose queries are missing an index.

  **The merge invents nothing.**
  [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md) §7 already defined every rule it
  needs, and now states the operation itself: `queries` de-duplicate on the canonical key and sort by
  it, `skipped` is the union of the parts, and `producers` is the union as a set on the
  `(name, revision)` pair. The result is a corpus in §7's sense — readable by anything that reads one
  — which is the requirement rather than a property it happens to have. `mergeCorpora` is exported for
  callers who want the merge without the verb. The union for `skipped` rather than the intersection:
  a reason one part discarded is a reason the merged view discarded, and the merged corpus is no more
  complete than its least complete part.

  **A part with nothing replayable in it is refused, and the refusal names that part.** `check`
  refuses a single empty corpus because one replays cleanly by construction and a pass would report
  coverage having measured nothing; a merge of three corpora one of which is empty is *not* empty, so
  a run that only examined the merge would lose that signal entirely and report full coverage for a
  set whose other consuming suite was never captured. A suite driven through the Firebase Web SDK
  produces exactly such a corpus, so this is a shape that really occurs; the remedy is to stop naming
  that part, which is one argument removed from the command line rather than a flag to discover.

  **Identity is read per part.** The line that echoes a corpus's producers is printed once per corpus,
  and `--require-identity` is applied to each: a merged `producers` naming someone does not mean every
  part named someone, and an anonymous stale part would otherwise hide behind a named current one,
  presenting a wider surface than any of the inputs with nothing recording which is which. This is
  what #55 made a list on the pair for.

  **Refused rather than merged across:** a part at a different `corpusVersion`, because the integer
  names the format both sides must agree on — named with the path, since the fix is to re-record one
  file; and a canonical key two parts hold with bodies that differ, which means a part has been
  edited or has arrived corrupted, since the key is injective over the shape. The second of those
  binds parts that did not come from a file: a corpus file whose key and body disagree is refused
  where it is read, because the reader re-derives the key from the body it is stored beside. A merge
  of parts that agree keeps the version they agree on and is not promoted, for the reason a read of a
  version-1 corpus serialises back to version 1. The corpus format is unchanged by this release.

  **Refused before the merge:** one corpus named twice, because a command meaning to name two suites
  that names one of them twice checks a narrower set than it reads as checking. The two spellings of
  one path are one corpus — `a.json` and `./a.json` are compared normalised — since a guard the
  shell's own tab completion can walk past is not a guard. Two paths that reach one file by different
  roots are still two, which is the part nothing here can settle.

- **A corpus records who produced it** (issue #55), and `check` echoes it beside the target on every
  run. `check` already refuses an *empty* corpus, on the grounds that one replays cleanly by
  construction and a pass would report coverage having measured nothing. A corpus that is merely old
  fails the same way and is harder to see: its entries describe a suite as it was, they are replayed
  against a set as it is, and the result is reported as coverage of the set. A suite that stopped
  running, a capture step dropped from a pipeline, a file committed once and never regenerated — each
  leaves a corpus that looks exactly like a current one, and the run it feeds exits `0`. It was the
  one input the verb still took on trust.

  **The identity is supplied, never discovered**, and that is a consequence of the file's diff
  stability rather than a convenience. `--producer <name>` and `--revision <rev>` on `record` are
  written into the corpus as a `producers` list. A wall-clock timestamp would rewrite the file on
  every run whether or not the queries changed, and a file that churns is a file whose diffs stop
  being read; the recorder also puts nothing about the machine into the file — no hostname, no
  username, no absolute path — which is the leak
  [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md) §7 already refuses when it declines
  to interpolate wire-decoded text into `skipped`, arriving from the other side. `--revision` without
  `--producer` is a usage error rather than a value quietly dropped, and a name or revision carrying
  a control character, a line break, an invisible character, or a bidirectional override is refused
  where it enters: the value is written into a reviewed file and echoed onto the stream the target
  is announced on, and each of those stops the written name from being the name that is read.

  **`--require-identity` on `check`** refuses a corpus that names no producer, with exit `2` — a run
  that cannot report, not a run reporting a gap — before anything is dialled or settled. It is off by
  default and has to be: every corpus written before this format version names none, so requiring it
  unconditionally would refuse them all.

  **`producers` is a list, and a set on the pair.** Sorted by name and then by revision, with an
  absent revision before any present one, `[]` when none were named. A list rather than one producer
  because §7's merge is a union and a merged corpus has to record which part came from where; a set
  on the pair rather than on the name because two revisions of one suite — a current part and a stale
  part — is exactly what the identity exists to make visible.

- **`--baseline <file>` on `check`**, so the verb can be adopted by a project that already has gaps.
  `check` exits `1` on any entry the candidate set does not serve, which is the right answer for a
  gap a run just found — the oracle is Firestore rather than a heuristic. It left a codebase of any
  age with two options and both ended with the check switched off: every existing gap arrives in one
  run, and fixing all of them before the first green run is not something a pipeline waits for. So
  it goes in non-blocking, or behind `|| true`, and [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md)
  §8's failure arrives by a different door — not a tool teaching suppression through false positives,
  but one whose true positives can only be silenced wholesale. A baseline names accepted keys, each
  with a `reason`; an entry in it is reported and does not fail the run, and anything else exits `1`.
  Issue #57.

  **The `reason` is required, and a blank one is refused.** Nothing here can tell a justified entry
  from one added to make a build green, so the only enforceable thing is that somebody wrote a
  sentence — printed back by every run that matches the entry, so it is re-read rather than
  accumulated. For the same reason nothing generates the file: a generated baseline is a list of keys
  with no reasons, which is exactly the artefact the rule exists to prevent.

  **Keys match exactly.** They are canonical and unique within a corpus (§7), so a new gap cannot
  inherit an old one's acceptance by resembling it. The file has its own `baselineVersion`, separate
  from `corpusVersion`: the two are edited by different hands on different schedules, and a corpus
  bump that forced every baseline to be rewritten would be one nobody could afford to make.

  **A baselined gap is still a gap.** It is reported with the same `not served` lead as any other,
  and the summary line names both totals, so a run that exits `0` carrying accepted gaps cannot read
  as one that found none. §2 is about what may be claimed, and deciding to live with a gap claims
  nothing about the index being unnecessary.

  **Entries that no longer reproduce are reported**, so the file shrinks as gaps close rather than
  accumulating into a list nobody can justify — either because the corpus no longer holds the query,
  which is answered before any client is built, or because the target now serves it, which is part of
  the report and is withdrawn with it. An entry the run got no verdict for is deliberately not
  reported as stale: an unreplayable entry, one after the entry that stopped the run, or any entry at
  all when the corpus itself replayed nothing, was never measured, and shrinking the file on that
  evidence would drop a gap that comes back as a finding the next time it is reached. Whether a stale
  entry should itself fail the run is left open; #57 names it a separate decision.

### Changed

- **`CheckCommand.corpus` is `readonly string[]` rather than `string`**, so a caller building the
  command itself passes a list. One passing the old string is refused by name with exit `2` rather
  than having its path walked a character at a time, and so are a list that is empty and a list that
  names one path twice — the three things the member documents about itself, at the boundary the
  exported verb owes a caller the parser does not reach. Named here for the reason `requireIdentity`
  below is: the type is exported, and a caller constructing one greps here.

  A command naming no `--corpus` still defaults to `firestore.queries.json`, but two command lines do
  change meaning. `--corpus a.json --corpus b.json` named `b.json` alone before this release and now
  checks both merged; `--corpus a.json --corpus a.json` parsed before and is now a usage error.

- **`corpusVersion` is `2`.** Adding a top-level member is the case the integer exists for: a reader
  that did not know `producers` would refuse a corpus for carrying a member the format does not
  define, which is true and says nothing about why. Version `1` remains readable and is read as a
  corpus naming no producer, so nothing committed before this release is refused, and a corpus read
  at version `1` serialises back to version `1` rather than being rewritten into `2`. Knowing two
  versions is not the fallback §7 forbids — that rule is about an *unknown* version, whose members a
  reader can only guess at — and §7 now says so. What a reader still may not do is read a corpus of
  one version as though it were another: the member set is part of what the integer names.

- **`buildCorpus` takes a third argument**, the producers, defaulting to none, and throws
  `CorpusError` on a name or a revision the reader would refuse — nothing this package writes may
  fail to read back. `Corpus` gains a `producers` member, and `serialiseCorpus` refuses a corpus
  that has none as well as one carrying producers at a version with no member to write them into:
  both were ways to lose an identity without a word. The JS API is provisional before 1.0 (§10), and
  this is named here because a caller greps the changelog for the symbol it calls.

- **`CheckCommand` gains a `requireIdentity` member**, and it is required rather than optional, so a
  caller naming the type builds a command that says which way the guard is set. `check` itself is
  unchanged for a caller that passes `false`. Named for the same reason as `buildCorpus` above: the
  type is exported, and a caller constructing one greps here.

### Fixed

- **Every spelling of the IPv6 loopback is recognised, not the two that were enumerated** (issue
  #27). `classifyHost` matched `::1` and `0:0:0:0:0:0:0:1` as strings, so `0::1`, `0:0::1`, and
  `0:0:0:0:0:ffff:127.0.0.1` — each of which `net.isIP` and a socket read as the loopback — classified
  `remote`, and `FIRESTORE_EMULATOR_HOST=[0::1]:8080`, which a compose file or a v6-first runner
  produces without anyone choosing the spelling, was refused with `--allow-remote-emulator` offered
  as the remedy. That is the outcome the refusal exists to prevent: once the override is on for a
  run it is on for every upstream in it. An IPv6 literal is now expanded to its eight groups before
  being compared, so the answer depends on the address and not on how it was written; the same
  expansion carries the IPv4-mapped and all-zeros cases, which were spelling-matched too. `isIP`
  remains the only judge of what is a literal, and it still resolves nothing.

  Two shapes are refused on purpose and are now pinned by tests rather than left to fall through.
  The legacy shorthand `127.1` is loopback to `getaddrinfo` and not an address to this check, for
  the same reason `127.0.0` is not; and a zoned literal such as `::1%lo0`, which `isIP` accepts, is
  not expanded, because reading past the `%` would admit the address by accident. `127.000.000.001`,
  which `isIP` rejects and `getaddrinfo` reads as loopback either way, keeps classifying `loopback`
  as it did before — pinned so that it does not change without a decision. Its mapped spelling,
  `::ffff:127.000.000.001`, is the one string that moves the other way: it was admitted because the
  part after `::ffff:` was read as a dotted quad, and is now `remote` because `isIP` judges the whole
  literal and rejects it. `getaddrinfo` still reads it as loopback, so this is a narrowing, of a
  spelling with no known writer; it is pinned by a test rather than left to be found.

- **A deeply nested version value is refused rather than overflowing on the way** (issue #60).
  `parseCorpus` and `parseBaseline` are both documented to fail one way — `CorpusError` and
  `BaselineError`, never a repair — and both built the version-mismatch message by serialising the
  offending value. `JSON.parse` and `JSON.stringify` do not have the same recursion budget, and
  `stringify`'s frames are the heavier, so a file whose version was a deep enough nested array parsed
  and then threw a `RangeError` on the way to being refused. The exposure was the published API
  rather than the CLI, which catches `unknown` around both reads and exits `2`: a consumer catching
  `CorpusError` got an uncaught `RangeError` instead. Only the corpus half was ever reachable from a
  release — `parseBaseline` ships for the first time in this one — so the baseline half is a defect
  fixed before it could be caught.

  A composite version is now *named* rather than serialised — `corpusVersion [...] is not readable` —
  and nothing walks the value at all. Bounded by construction rather than by catching the overflow,
  which is the rule `MAX_FILTER_DEPTH` already applies to the filter tree: a caught `RangeError` is a
  guess about how much stack was left when the value arrived, and the depth at which it happens is a
  property of the runtime rather than of the file. A primitive version is serialised as it was
  before, so the message names the value — not always the file's spelling of it, since `1e2` is named
  `100` and an `Infinity` is named `null` — and a missing member still reads `undefined`.

- **A replayed query reads one document rather than the collection** (issue #43). What `check` asks
  is answered by the RPC's status; the rows come back and are discarded. Until now they came back in
  full — the synthesised sentinel matches nothing for an equality, but `!=`, `not-in`, and the
  negated unary operators match every document that merely *has* the field, so an entry recorded
  from `status != x` replayed as a read of the whole collection, buffered in memory, billed, and
  liable to end in a `DEADLINE_EXCEEDED` that classifies as `failed` and stops the run. The query
  now carries `limit(1)`.

  The query is the one `buildReplayQuery` returns, which is exported (§10 calls the JS API
  provisional before 1.0), so a caller reaching it directly gets one document where it used to get
  the result set. Named here rather than left to `check`'s description, because a caller greps the
  changelog for the symbol it calls.

  **The limit was measured before it was applied, in the direction §2 cares about.** A limit that
  narrowed index selection would turn a query that should have failed into a clean verdict, which is
  worse than a false alarm. Measured against a deployed candidate set over the probe's eight shapes:
  no shape changed its answer, the two uncovered ones still answered `FAILED_PRECONDITION` with the
  limit on — so the limit acquired no index — and the reads collapsed, 429 documents to 1 on the
  `!=` shape the issue names. That is eight shapes, one operand, one collection and one index set at
  one moment, and the docstring records it as such rather than as a claim about the planner.

  **What it does not reach is named there too.** All eight shapes are conjunctions against a single
  collection, while the limit goes on every query replay emits — disjunctions, `COLLECTION_GROUP`
  scope, `not-in`, `array-contains-any`, the negated unary forms. Those carry it on the argument
  that a limit is one field on the wire, not on a reading. Closing that needs an `or` shape and a
  `COLLECTION_GROUP` shape in the probe and another run of step 5b.

  Reading the status without reading the result — the stream closed after the first document that
  the issue proposes — was implemented and abandoned. `stream()` returns the tail of a `.pipe()`
  chain, so destroying it unpipes the upstream without cancelling the RPC: `close()` never returns,
  and the stalled `RunQuery` reissues from its cursor once its deadline passes. It blocks the
  verdict and reads more than `get()` does.

### Notes

- **What the `limit(1)` measurement reaches, and what it does not.** The reading behind the #43
  fix is eight shapes, all conjunctions of `EQUAL` and the ordering operators against a single
  collection. Replay emits more than that — a disjunction, a `COLLECTION_GROUP` scope, `not-in`,
  `array-contains-any`, and the negated unary forms — and the limit goes on all of it. A
  disjunction's index requirement is per-disjunct and a collection group's is a distinct index kind,
  so neither is a shape the run generalises over; they carry the limit on the argument that it is
  one field on the wire rather than on a reading, and `replay.ts` says so beside the call. Extending
  the probe with those two shapes is what would close it. The limits 0.5.0's notes named — one
  operand type per shape, arities 1, 3 and 10 only — still stand.
- **Two things are bounded through the file and not through the JS API.** `parseCorpus` refuses a
  filter tree deeper than it descends, so a corpus file cannot overflow the reader; a caller who
  builds a `Corpus` by hand and passes a tree of that depth to `mergeCorpora` or `serialiseCorpus`
  gets a `RangeError` from the runtime instead. The JS API is provisional before 1.0 (§10), the
  file is the boundary this package defends, and no writer this package knows of produces such a
  tree. Named so that it is a decision rather than a discovery.
- **#50 ships open, as it did in 0.5.0.** `reconcile` keys on fields rather than on `state`, so an
  index changing identity or state *while* `check` runs still reconciles as `identical`. Nothing in
  this release moved it either way.

## [0.5.0] — 2026-09-06

The `check` verb, and with it the half of the v0.3 coverage check that needs a Firestore client.
0.3.0 shipped the parts that were decidable offline and said to expect them to move once the verb
landed; in the event they did not — `planReplay` and the readiness gate acquired their first caller
without a single export changing shape, and both modules grew around them rather than under them.
`indexwright-record` still captures exactly what it captured in 0.2.0: nothing here touches the
corpus or the capture proxy.

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

- **The verb body** — readiness, then reconciliation, then replay, then reconciliation once more,
  each one a gate rather than a step. `check` reads the corpus and the candidate declarations first,
  before it constructs anything, because everything up to the first client is offline and everything
  after it costs a settling period at the least; a mistyped path is then found on the near side of
  that minute. It then polls the Admin API until `ReadinessGate` says the set has been quiet long
  enough, reconciles the listing it settled on against the candidate file, and only then replays. A
  run that cannot settle one of those questions declines and says which — it does not fall back to
  replaying against a set it cannot vouch for, which is the quietly-wrong behaviour §3 exists to
  rule out. After the last query is answered it lists once more and reconciles again, because
  everything the replay established is a statement about a window that opened at the first reading
  and nothing until now looked at the far end of it. That second look can only *withdraw*: it
  examines the set and not coverage, so a set that moved — or that could not be compared again —
  turns either verdict into a decline and neither verdict into the other.

  **Exit `1` is the finding and exit `2` is the absence of one.** Unlike `lint`, which defaults to
  exit `0` even with findings because its rules have unmeasured false-positive rates, the oracle here
  is Firestore itself — so a `FAILED_PRECONDITION` is worth failing a pipeline on. `2` covers every
  way the run could not answer, and it outranks `1`: a report missing entries is not a clean report
  with a caveat, and an operator who sees `1` should be able to read it as "these and no others".
  An entry that cannot be replayed, an `INVALID_ARGUMENT`, and a status the run cannot interpret all
  land there and are named out loud, because SPEC §7 reports `FAILED_PRECONDITION` and never the
  others: an invalid replay is a defect in this tool or in the test that issued the query, not a
  statement about the index set.

  **A corpus with nothing replayable in it is refused rather than reported as full coverage.** It
  replays cleanly by construction, so the run would exit `0` having measured nothing — and that is a
  shape which really occurs, since a suite driven through the Firebase Web SDK issues no gRPC at all
  and `record` writes a corpus with no queries and counts what it could not capture. The refusal is
  answered before any client is built, because no gate beyond it could change the answer.

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

- **`IndexLister` now requires `close`.** The exported type widened from
  `Pick<…, 'listIndexesAsync'>` to `Pick<…, 'listIndexesAsync' | 'close'>`, so an external test
  double or wrapper built to the old shape no longer typechecks. The affordance is the point — see
  issue #39 above — and the fix is one method: the real client's `close()` is idempotent and safe on
  one that never opened a channel.

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

### Fixed

- **`REPLAY_SENTINEL` is no longer spelled `__indexwright_replay__`.** The constant does two jobs —
  the value a synthesised filter compares against, and the id of the document a `__name__` filter
  names — and Firestore reserves every document id matching `__…__`, rejecting one as
  `INVALID_ARGUMENT` before it selects an index. So every corpus entry carrying a `__name__` filter
  replayed as `invalid` and never reached the question `check` was asking, which is precisely the
  failure SPEC §7 says the reference operand exists to avoid, arriving by the other door. Only that
  form is reserved: `__x` and `x__` are ordinary ids, and the string is a legal scalar whichever way
  it is spelled, so the constraint came entirely from the second job.

  The suite could not have caught it as written. Every test builds both the actual and the expected
  query from this same constant, so the two sides moved together and the comparison stayed true
  whatever it said — 336 tests green against a sentinel the emulator and the service both refuse.
  `replay.test.js` now pins the id rules against literals instead. Found by issuing the shapes at the
  emulator, which is what the harness in `probe/` was added to do.

  The verb is unreleased, so no published version ever carried the reserved spelling.

### Notes

- **What the measured run establishes, and what it does not.** The verb was exercised against a
  live throwaway database before this release rather than only against the emulator, and
  [`probe/README.md`](https://github.com/uny/indexwright/blob/main/probe/README.md) records the
  readings. Two limits on how far they carry. The differential harness fills a shape's *scalar*
  slots from one provider, so a two-filter shape is only ever issued with operands of the same
  type; if Firestore's index selection turned on the *combination* of types — `a == <string>`
  together with `b > <number>` — the harness would report the shape constant and see nothing.
  Replay collapses the same combinations, so neither side of the check can separate that case.
  Separately, the run issued filter arities of 1, 3 and 10 only: 2 and 4 through 9 are unobserved.
  Neither limit is known to matter; both are unmeasured, and SPEC §7 says so in the same terms.
- **Two false-clean paths remain open, deliberately.**
  [#50](https://github.com/uny/indexwright/issues/50) is the same class as the second reconciliation
  described above, and survives it: `reconcile` keys on fields and not on `state`, so an index
  deleted and recreated under another name during the replay, or dropped to `CREATING` or
  `NEEDS_REPAIR`, still reconciles as `identical`. Reaching it takes an index changing identity or
  state *while* `check` runs, which is operator-caused rather than the normal path — and closing it
  costs a second settling period on every run, which is not a trade this release makes.
  [#43](https://github.com/uny/indexwright/issues/43) is a cost, not a wrong verdict: a corpus entry
  recorded from an inequality replays as a read of the matching documents and `check` buffers all of
  them to learn a status. Measured at 429 documents for one entry against the 500-document probe
  corpus. Against a populated collection that is the collection, per such entry. Point `check` at a
  throwaway target, which SPEC §3 requires of it for other reasons anyway.

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

[0.8.0]: https://github.com/uny/indexwright/releases/tag/record-v0.8.0
[0.7.0]: https://github.com/uny/indexwright/releases/tag/record-v0.7.0
[0.6.0]: https://github.com/uny/indexwright/releases/tag/record-v0.6.0
[0.5.0]: https://github.com/uny/indexwright/releases/tag/record-v0.5.0
[0.4.0]: https://github.com/uny/indexwright/releases/tag/record-v0.4.0
[0.3.0]: https://github.com/uny/indexwright/releases/tag/record-v0.3.0
[0.2.0]: https://github.com/uny/indexwright/releases/tag/record-v0.2.0
