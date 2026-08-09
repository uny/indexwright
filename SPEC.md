# indexwright — Specification

Linter and query-coverage checker for Firestore composite indexes.

Status: **v0.1.0 (draft)**. Pre-1.0: rules and CLI surface may change between minor versions.

---

## 1. Why this exists

Firestore composite indexes are declared as data (`firestore.indexes.json`) and applied as
whole-state. Three properties of the platform make that declaration hard to get right, and none of
them are addressed by existing tooling.

**The emulator does not enforce composite indexes.** The Firestore emulator "does not track
composite indexes and instead executes any valid query." A query that will fail in production with
`FAILED_PRECONDITION` passes locally. Strict indexing in the emulator is not a planned feature.

**Firestore exposes no per-index usage metrics.** Index entry reads are billed but do not appear in
the usage dashboard, and there is no index-level metric. You cannot ask the platform which of your
indexes are actually used, so you cannot safely identify unused ones.

**The index-matching rule is undocumented.** Google's documentation states that field ordering must
be specified, but does not define how field order maps to query shape — in particular whether the
relative order of equality and `array-contains` fields before the range fields affects matching.
This means index changes cannot be validated against documentation; only empirically.

The asymmetry is stark: security rules have an official test harness
(`@firebase/rules-unit-testing`) and can be verified in the emulator. **Composite indexes have no
equivalent.** A survey of GitHub and npm found no linter for `firestore.indexes.json`; the only
adjacent projects are three abandoned index *generators* (0–6 stars, last pushed 2021–2025).

Consequently, index declarations drift into states that are detectable by inspection but that
nothing inspects: inconsistent `queryScope` within a collection, near-duplicate indexes that differ
only in field order, artifacts of round-tripping through live exports, and silent approach to the
per-database index quota.

## 2. What this is not

**indexwright cannot determine whether an index is needed.** That question requires the queries,
which live in application code, not in the index declaration. No rule in this specification asserts
that an index is unnecessary, and no output should be read as authorising a deletion.

Deleting a composite index is not symmetric with adding one: an addition does not disturb existing
queries while it backfills, but a deletion breaks its queries the moment it takes effect, and
restoring it requires a fresh backfill. **A linter that only sees the declaration must never be the
basis for a deletion.**

What indexwright asserts is narrower and safer: *these declarations are structurally inconsistent
with each other, and a human should look.*

## 3. Scope

### v0.1.0

Static analysis of index declaration files. Four rules (§5). No network access, no credentials, no
Firestore connection.

### Planned

- **v0.2 — query capture.** The Firestore emulator speaks the public Firestore v1 gRPC API in
  plaintext on a local port. An intercepting proxy can decode `RunQuery` requests and record the
  observed `StructuredQuery` shapes, yielding a query corpus harvested from execution rather than
  hand-written. This is language- and framework-independent, because it operates on the wire
  protocol rather than on source code. The corpus format is specified in §7.
- **v0.3 — coverage check.** Replay a captured corpus against a throwaway Firestore database that
  has the candidate index set applied, and report queries that fail with `FAILED_PRECONDITION`.
  The oracle is Firestore itself; indexwright does not reimplement the undocumented matching rule.

The v0.2/v0.3 split is deliberate: capture is cheap and offline, while the coverage decision is
delegated to the platform. Reimplementing index matching would risk emitting false
`FAILED_PRECONDITION` verdicts and blocking development on a rule that is not published.

**Packaging of v0.2/v0.3.** Capture needs a gRPC stack — `@grpc/grpc-js` and protobuf definitions
for the Firestore v1 API — and hand-writing a decoder for a wire format owned by someone else is
not a cost worth paying. That collides with §8: `record` and `check` run inside an adopter's
project, so their dependencies land in an adopter's tree, and the build-time carve-out does not
reach them.

They therefore ship as a separate package, `@indexwright/record`, which depends on `indexwright`
for the index model and the `json` contract. **`indexwright` itself acquires no runtime dependency,
in any version.**

The split is not a workaround; it puts each cost where it is cheapest. `lint` runs on every push,
in every CI job, in projects that may never touch Firestore from a server — that is where a
transitive dependency tree is least welcome. `record` runs against a local emulator, in a project
that is already talking to Firestore server-side and therefore already resolves `@grpc/grpc-js`
transitively through `@google-cloud/firestore`. The dependency is added where it is very likely
already resolved, and is absent where it would be new.

The cost is a second package to discover. `indexwright record` in an installation that has only the
linter must say where the verb lives, not report an unknown command.

**Known limit of v0.2/v0.3:** coverage is bounded by what actually exercises the proxy. A query that
no test issues is not observed, and absence of observation is not evidence that an index is unused.
This limit is inherent, not an implementation gap.

## 4. CLI

```
indexwright lint <file...> [options]

Options:
  --format <fmt>        text (default) | json | github
  --max-warnings <n>    exit 1 if warnings exceed n (default: unlimited → always exit 0)
  --rule <id>           run only the given rule; repeatable
  --disable <id>        skip the given rule; repeatable
  --quota <n>           per-database composite index limit for R4 (default: 1000)
  --quota-threshold <p> warn above this fraction of the limit (default: 0.8)
```

### Exit codes

| Code | Meaning |
|-----:|:--------|
| 0 | Completed. Warnings may have been emitted (default policy). |
| 1 | Warning count exceeded `--max-warnings`. |
| 2 | Usage error, unreadable file, or malformed input. |

**The default is exit 0 even with findings.** A linter whose rules have unmeasured false-positive
rates must not gate a pipeline by default. Adopters opt into enforcement with `--max-warnings`
once they have measured their own noise level.

### Input

Any file in the `firestore.indexes.json` shape:

```jsonc
{
  "indexes": [
    {
      "collectionGroup": "…",
      "queryScope": "COLLECTION" | "COLLECTION_GROUP",
      "fields": [ { "fieldPath": "…", "order": "ASCENDING" | "DESCENDING" }
                | { "fieldPath": "…", "arrayConfig": "CONTAINS" }
                | { "fieldPath": "…", "vectorConfig": { … } } ],
      "density": "…"          // optional, passed through
    }
  ],
  "fieldOverrides": [ … ]     // parsed, not analysed in v0.1.0
}
```

Multiple files may be passed; each is analysed independently. Rules are not applied across files.

### Validation

A file is **malformed** when it is not valid JSON, when the top level is not an object, when
`indexes` is absent or is not an array, when an index lacks `collectionGroup`, `queryScope`, or a
non-empty `fields`, or when a field lacks `fieldPath` or declares none — or more than one — of
`order`, `arrayConfig`, and `vectorConfig`.

Nothing beyond that is refused. The *values* of `queryScope` and `order` are not checked against an
enumeration, unknown keys anywhere are ignored, and a declaration that repeats a `fieldPath` within
one index — which does occur in live exports — is carried through rather than rejected. Refusing to
analyse a file is the harshest outcome available to a tool that otherwise only warns, and it costs
the reader every other index in the file, so it is reserved for input that cannot be read as an
index declaration at all.

Malformed input does not abort the run. Each file is read and analysed on its own: files that parse
are linted and their findings reported, files that do not are reported as errors, and the process
exits 2 once every file has been handled. Reporting only the first bad file would hide findings in
the files that were fine.

## 5. Rules

Every rule emits **warnings**, never errors. Each finding carries: rule id, file, a canonical index
key, and a one-line reason. A finding that concerns the file as a whole rather than any particular
index carries a **null** key.

A rule whose subject is a *set* of indexes emits one grouped finding for that set, not one finding
per member. The finding's `key` is the lexicographically smallest member key and `related` holds the
remaining member keys, sorted ascending and de-duplicated. This keeps the warning count proportional
to the number of problems rather than to the number of indexes, which matters because
`--max-warnings` is counted in findings.

### Canonical index key

```
<collectionGroup>::<queryScope>::<fieldPath>:<direction>|<fieldPath>:<direction>|…
```

where `direction` is `ASCENDING`, `DESCENDING`, `CONTAINS`, or — for a `vectorConfig` field —
`VECTOR(<dimension>)`, written `VECTOR(?)` when no dimension is declared. A trailing implicit
`__name__` entry is stripped before forming the key, so that declarations that differ only in
whether the document key is written explicitly resolve to the same resource.

### The implicit `__name__` direction

Firestore appends the document key to every composite index, and its direction is not declared, so
stripping it requires knowing which direction it would have had. indexwright defines that direction
as **the `order` of the last preceding field that carries an `order`, or `ASCENDING` when no
preceding field carries one** — the latter arising when the index ends with an `arrayConfig` field.

This is not published behaviour. It is read off live exports, which render the key explicitly:
`[type ASC, createdAt DESC, __name__ DESC]`, `[public ASC, startAt ASC, __name__ ASC]`, and
`[isRecommended ASC, tags CONTAINS, __name__ ASC]` are all shapes an export produces.

The definition is used only to decide whether a written `__name__` is redundant, and the decision is
deliberately one-sided: a trailing `__name__` is stripped **only** when its direction equals the
value above, and one that differs — `[totalNbUses DESC, __name__ ASC]` occurs in real exports — is
treated as meaningful and kept. A wrong definition can therefore fail to merge two spellings of one
index, but can never merge two indexes that are actually distinct.

---

### R1 · `scope-mismatch`

**Detects.** Within one `collectionGroup`, more than one distinct `queryScope` is declared. One
finding is emitted per affected `collectionGroup`, reporting how many indexes each scope holds.

The scope with the fewest indexes is named as the minority, and the finding's keys are that scope's
indexes. When no scope holds a strict minority — an even split — the finding says so instead of
naming one, and reports the keys of the lexicographically first scope. It still fires: the detection
condition is that the scopes disagree, and an even split is a disagreement. Suppressing it would
narrow the rule to a shape the rule does not claim.

**Rationale.** A `COLLECTION`-scoped index does not serve a collection-group query, and vice versa.
When every other index on a collection uses one scope and a newly added one uses the other, the new
declaration is frequently a mistake that will surface only as a production `FAILED_PRECONDITION`.

**False positives.** Legitimate when an application queries the same collection both as a single
collection and as a collection group. This is why the rule warns rather than fails.

---

### R2 · `field-order-variant`

**Detects.** Two or more indexes that share `collectionGroup`, `queryScope`, and the same *set* of
`fieldPath:direction` pairs, but declare them in different orders.

"Same set" means the same *multiset*: a `fieldPath` that repeats within one index is unusual but not
rejected (§4), and comparing multisets keeps the grouping well defined when it does. The comparison
runs on the canonicalised field list, so an index that writes `__name__` explicitly groups with one
that does not. Two indexes that are byte-identical do not constitute different orders and do not
fire this rule.

**Rationale.** Firestore treats a different field order as a different index. Each variant consumes
write amplification, storage, and quota independently. Variants proliferate easily: a query change
that reorders fields adds a new index without removing the old one, and round-tripping through a
live export can reintroduce an ordering that was intended to be replaced.

**False positives.** Legitimate when distinct queries genuinely require distinct orderings — for
example, two queries that order by the same two fields in opposite directions. The finding asks for
that justification to be recorded, not for one variant to be removed.

**Output.** All members of the variant group are listed together, so the reader can judge the set
rather than one member at a time.

---

### R3 · `explicit-name-field`

**Detects.** An index whose **last** `fields` entry is an explicit `__name__` carrying the implicit
default direction (§5, *The implicit `__name__` direction*). A `__name__` written anywhere other
than last, or written last with a direction other than the default, is not flagged.

**Rationale.** Firestore appends the document key implicitly; live exports render it explicitly.
An explicit `__name__` in a hand-maintained declaration is therefore a signature of a value that
round-tripped through an export rather than being authored directly. It does not change the
resource identity, but it makes the file inconsistent and can mask genuine duplicates from
naive text comparison.

**False positives.** Explicit `__name__` with a direction that differs from the implicit default is
meaningful and should not be flagged. The rule only fires on a trailing `__name__` matching the
implicit default.

---

### R4 · `quota-headroom`

**Detects.** The number of composite indexes in the file exceeds `--quota-threshold` of `--quota`.

**Rationale.** Composite indexes are capped per database. The limit is reached gradually and
silently; the first symptom is a failed index creation at deploy time, which is a poor moment to
discover it. Reporting headroom continuously makes the trend visible.

The comparison is a strict `count > quota × threshold`, so the defaults (1000, 0.8) fire at 801.

**False positives.** None in principle; the threshold is configurable because appropriate headroom
depends on the rate of index growth.

**Output.** The finding is about the file, not about any one index, so its `key` is `null` and its
`related` is empty. One finding per file at most.

## 6. Output formats

**`text`** — human-readable, grouped by rule, intended for a terminal.

**`json`** — a stable machine-readable shape:

```jsonc
{
  "version": "0.1.0",
  "files": ["…"],
  "summary": { "warnings": 0, "errors": 0, "byRule": { "scope-mismatch": 0, … } },
  "findings": [
    {
      "rule": "scope-mismatch",
      "file": "…",
      "key": "…",             // null for a finding about the file as a whole
      "message": "…",
      "related": ["…"]        // other keys in the same finding group; [] when there are none
    }
  ],
  "errors": [
    { "file": "…", "message": "…" }   // files that could not be read or parsed
  ]
}
```

`files` lists every file the run was given, whether or not it parsed, sorted by path. `byRule` holds
one entry for every rule that ran after `--rule` and `--disable` were applied, including rules that
found nothing; a rule that did not run is absent rather than zero. `findings` is sorted by file,
then by rule in the order of §5, then by key with a null key sorting first. `related` is sorted
ascending. `errors` is sorted by file. Every field is always present: `related` is `[]` rather than
omitted, and `errors` is `[]` on a clean run.

**`github`** — GitHub Actions workflow commands (`::warning file=…::`) plus a Markdown summary
suitable for `$GITHUB_STEP_SUMMARY`.

## 7. Query corpus (v0.2)

`record` writes a **query corpus**: the set of distinct query shapes observed on the emulator's wire
during a run, conventionally `firestore.queries.json`. The corpus is the contract between capture
(v0.2) and the coverage check (v0.3), and it is meant to be committed alongside
`firestore.indexes.json` and reviewed in a diff like any other declaration.

### What a shape is

A shape is the part of a `StructuredQuery` that determines which index can serve it: the collection,
the query scope, the filter tree, and the sort order. Everything else is discarded.

**Values are not recorded.** A query's values are customer data, and the corpus is a file that
persists in a repository. They are also unnecessary: index selection is a function of field paths,
operators, and directions, not of what is compared against. Discarding them removes the only part of
a captured query that could carry a secret, and removes the only part that changes between runs of
the same test.

**Project and database are not recorded.** They are properties of the environment the capture ran
in, not of the query, and recording them would make a corpus captured against one emulator instance
look different from the same corpus captured against another.

**`limit`, `offset`, cursors, and `select` are not recorded.** None of them changes which index
serves the query; a projection is served by the index the underlying query already needs.

**Occurrence counts are not recorded.** A corpus is a set, not a histogram. A count changes on every
run without changing anything about what must be indexed, which would make the file churn in every
diff and train reviewers to skim it. `record` reports counts on stderr, where they are useful for
triage and where they do not have to be committed.

### Vocabulary

The corpus reuses the declaration vocabulary of §5, so that a corpus entry and an index key can be
read against each other without translation.

| Corpus | Source on the wire | Aligns with |
|:--|:--|:--|
| `collectionGroup` | `CollectionSelector.collection_id` | index `collectionGroup` |
| `queryScope` — `COLLECTION` \| `COLLECTION_GROUP` | `all_descendants` | index `queryScope` |
| `direction` — `ASCENDING` \| `DESCENDING` | `Order.direction` | field `order` |
| `op` — `ARRAY_CONTAINS` | `FieldFilter.Operator` | field `arrayConfig: CONTAINS` |

Operators are written with their protobuf enum names: `LESS_THAN`, `LESS_THAN_OR_EQUAL`,
`GREATER_THAN`, `GREATER_THAN_OR_EQUAL`, `EQUAL`, `NOT_EQUAL`, `ARRAY_CONTAINS`, `IN`,
`ARRAY_CONTAINS_ANY`, `NOT_IN` for a field filter; `IS_NAN`, `IS_NULL`, `IS_NOT_NAN`, `IS_NOT_NULL`
for a unary filter; `AND` and `OR` for a composite. Enum names rather than SDK spellings, for the
same reason §5 writes `ASCENDING` rather than `asc`: the file speaks Firestore's own vocabulary, and
an unrecognised operator can then be reported by name instead of being silently dropped.

### Canonical query key

```
<collectionGroup>::<queryScope>::<where>::<orderBy>
```

`<where>` serialises the filter tree: a field or unary filter as `<fieldPath>:<op>`, a composite as
`<op>(<child>|<child>|…)`. The root is always a composite, so a query with one filter serialises as
`AND(status:EQUAL)` and a query with none as `AND()`. `<orderBy>` is `<fieldPath>:<direction>`
joined by `|`, and is empty when the query declares no sort order. A two-filter, two-sort query
keys as:

```
orders::COLLECTION::AND(amount:GREATER_THAN|status:EQUAL)::amount:DESCENDING|createdAt:ASCENDING
```

Both `AND` and `OR` are commutative, so a composite's children are sorted by their own serialised
form before joining. This makes the key independent of the order the filters were written in, which
is what allows two spellings of one query to collapse into one corpus entry. Sort order is *not*
commutative and is preserved as sent.

Repeated children are kept rather than de-duplicated, for the reason §5 compares multisets:
`tier == "a" OR tier == "b"` is a two-disjunct query whose shape is `OR(tier:EQUAL|tier:EQUAL)`, and
collapsing it to one disjunct would describe a query that was never issued.

### File shape

```jsonc
{
  "corpusVersion": 1,
  "queries": [
    {
      "key": "orders::COLLECTION::AND(status:EQUAL)::createdAt:DESCENDING",
      "collectionGroup": "orders",
      "queryScope": "COLLECTION",
      "where": {
        "op": "AND",
        "filters": [
          { "fieldPath": "status", "op": "EQUAL" }
        ]
      },
      "orderBy": [
        { "fieldPath": "createdAt", "direction": "DESCENDING" }
      ]
    }
  ],
  "skipped": ["aggregation-query"]
}
```

A node carrying `filters` is a composite; a node carrying `fieldPath` is a leaf. `where` is always
present and always a composite. `orderBy` is `[]` rather than omitted. `queries` is sorted by `key`,
and `skipped` holds the distinct reasons observed, sorted ascending — a set, so that it is as
diff-stable as the rest of the file. Counts for each reason go to stderr.

`corpusVersion` is an integer that names the format, not the tool: it changes only when a corpus
written by one version can no longer be read correctly by another, and it does not move when
`@indexwright/record` is released.

### Implicit fields are not materialised

Firestore appends the document key to every query's sort order, and promotes an inequality field
into it, but neither appears on the wire — the client sends what the application wrote, and the
server completes it. The corpus records what was sent.

This is deliberate. §5 has to define the implicit `__name__` direction because a linter comparing
two declarations has no other way to tell whether they name the same resource. A corpus has no such
need: the v0.3 oracle is Firestore itself, which applies the real rule. Materialising a guessed
`__name__` into the corpus would put an unpublished behaviour into a durable file and make every
entry wrong if the guess were wrong. When a human reads a corpus entry against an index key, §5's
definition is the one that applies.

### Replay without values

v0.3 must turn a corpus entry back into a query it can execute, and the entry has no values to put
back. It synthesises them: a unary filter needs none, `IN`, `NOT_IN`, and `ARRAY_CONTAINS_ANY` need
a one-element array, and everything else needs a single scalar.

This rests on the claim above — that index selection does not depend on the compared value or its
type. The claim is consistent with how the field is indexed rather than the value, but it is not
published, and it is the one assumption in v0.3 that a synthesised replay could get wrong. If it is
false, replay reports `FAILED_PRECONDITION` where a real query would have succeeded, which is a
false positive of exactly the kind §2 forbids acting on. v0.3 must test the claim before it reports.

### What is not captured

`record` captures `RunQuery`. Two things it sees but does not record:

- **`RunAggregationQuery`** — `count()`, `sum()`, and `average()` carry a `StructuredQuery` and have
  their own index requirements, which are not necessarily those of the underlying query. Recording
  the inner query would misreport them, so v0.2 counts them as `aggregation-query` and records
  nothing. Capturing them properly is a v0.3-or-later extension.
- **`find_nearest`** — vector search is recorded as `vector-query` and skipped for the same reason:
  it is served by a `vectorConfig` index whose matching rule this specification does not yet model.

They are reported rather than dropped silently. §3's known limit — that coverage is bounded by what
exercises the proxy — is about queries no test issues; a query that *was* issued and then discarded
without trace would be a different and worse failure, because it would look like coverage.

## 8. Design principles

**Warn, do not fail.** The rules encode heuristics whose false-positive rates are, at v0.1.0,
unmeasured. Shipping them as blocking checks would teach users to suppress the tool. Enforcement is
opt-in and per-adopter.

**Never authorise a deletion.** See §2. No output phrasing may suggest that an index is unused or
safe to remove.

**No dependencies in `indexwright`.** A linter that pulls a dependency tree into a build pipeline
undermines its own purpose. Argument parsing and formatting are implemented in-tree, and the
published package declares no runtime dependencies. This is a property of the package rather than
an aspiration of the project: it holds in every version, and a test asserts it.

The principle is about what lands in an adopter's tree, so build- and test-time tooling that never
ships is out of its scope. It is not a claim that no part of indexwright may depend on anything.
Where a verb needs a library it cannot reasonably write — the gRPC stack behind `record` (§3) —
that verb ships as its own package instead of as a dependency of the linter. What the principle
forbids is making every adopter of `lint` pay for it.

**No network, no credentials, in `lint`.** Static analysis must be runnable in any environment,
including a sandboxed CI step with no cloud access. Network use is confined to the planned
`record`/`check` verbs, which are separate commands in a separate package (§3).

**Delegate undocumented semantics to the platform.** Where Firestore's behaviour is not published —
principally index matching — indexwright measures rather than models. This bounds what the tool can
claim, which is the point.

**Deterministic output.** Findings are emitted in a stable sort order (file, rule, key), so that
output can be diffed across runs.

## 9. Testing

Rules are tested against small hand-written fixtures that isolate one condition each, with explicit
positive and negative cases.

**Assertions are never written against a real project's index file.** A test that asserts a finding
count over live data fails whenever that data legitimately changes, which trains maintainers to
edit the test rather than read it. Fixtures encode the invariant; real files are for manual
exploration only.

## 10. Compatibility

- Node.js ≥ 22, ESM.
- Input schema follows the Firebase CLI's `firestore.indexes.json`. Unknown keys are preserved and
  ignored rather than rejected, so that a newer field does not break linting.
- Semantic versioning. Pre-1.0, rule additions and message changes may land in minor releases;
  the `json` output shape is the stable contract and changes only in major releases after 1.0.
- The package also exports a JavaScript API, so the rules can be run without spawning a process.
  That API is **provisional**: it is not part of the stable contract before 1.0 and may change in
  any minor release. Only the `json` output shape carries the compatibility promise.
- indexwright is published as a family: `indexwright`, the linter, which carries no runtime
  dependencies, and — from v0.2 — `@indexwright/record`, capture and coverage, which depends on the
  linter and on a gRPC stack (§3). They version independently; `@indexwright/record` declares the
  range of `indexwright` whose `json` contract it reads.

## 11. Toward 1.0

1.0 requires, at minimum:

- Measured false-positive rates for R1 and R2 across more than one real project.
- At least one adopter outside the project of origin.
- A decision, informed by that data, on whether any rule should default to failing.

Until then the version stays below 1.0 and the README states plainly that the rules are provisional.
