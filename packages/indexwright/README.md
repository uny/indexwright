# indexwright

Linter for Firestore composite index declarations — `firestore.indexes.json`.

> **The rules are provisional.** Their false-positive rates are unmeasured, so every rule emits a
> warning and the default exit code is 0 even with findings. See [Toward 1.0](#toward-10).

## Why

Firestore composite indexes are declared as data and applied as whole-state, and three properties of
the platform make that declaration hard to get right:

- **The emulator does not enforce composite indexes.** A query that will fail in production with
  `FAILED_PRECONDITION` passes locally.
- **There are no per-index usage metrics.** You cannot ask the platform which indexes are used.
- **The index-matching rule is undocumented.** Index changes cannot be validated against
  documentation, only empirically.

Security rules have an official test harness and can be verified in the emulator. Composite indexes
have no equivalent. So declarations drift into states that are detectable by inspection but that
nothing inspects: inconsistent `queryScope` within a collection, near-duplicate indexes that differ
only in field order, artifacts of round-tripping through live exports, and a silent approach to the
per-database index quota.

## What this is not

**indexwright cannot determine whether an index is needed.** That question requires the queries,
which live in application code, not in the index declaration. No rule asserts that an index is
unnecessary, and no output should be read as authorising a deletion.

Deleting a composite index is not symmetric with adding one: an addition does not disturb existing
queries while it backfills, but a deletion breaks its queries the moment it takes effect, and
restoring it requires a fresh backfill. A linter that only sees the declaration must never be the
basis for a deletion.

What indexwright asserts is narrower: *these declarations are structurally inconsistent with each
other, and a human should look.*

## Install

```bash
npm install --save-dev indexwright
```

Node.js 22 or newer. No runtime dependencies.

Or run it without installing:

```bash
npx indexwright lint firestore.indexes.json
```

## Usage

```
indexwright lint <file...> [options]

Options:
  --format <fmt>        text (default) | json | github
  --max-warnings <n>    exit 1 if warnings exceed n (default: unlimited)
  --rule <id>           run only the given rule; repeatable
  --disable <id>        skip the given rule; repeatable
  --quota <n>           per-database composite index limit (default: 1000)
  --quota-threshold <p> warn above this fraction of the limit (default: 0.8)
  -h, --help            show the usage
      --version         show the version
```

### Exit codes

| Code | Meaning |
|-----:|:--------|
| 0 | Completed. Warnings may have been emitted. |
| 1 | Warning count exceeded `--max-warnings`. |
| 2 | Usage error, unreadable file, or malformed input. |

**The default is exit 0 even with findings.** A linter whose rules have unmeasured false-positive
rates must not gate a pipeline by default. Opt into enforcement with `--max-warnings` once you have
measured your own noise level.

## Rules

| Id | Detects |
|:---|:--------|
| `scope-mismatch` | One `collectionGroup` declaring more than one `queryScope`. |
| `field-order-variant` | Indexes over the same field set, declared in different field orders. |
| `explicit-name-field` | A trailing `__name__` that restates the direction Firestore appends anyway. |
| `quota-headroom` | The declared index count is close to the per-database limit. |

Each rule's rationale, its known false positives, and the exact detection condition are in
[SPEC.md](../../SPEC.md) §5.

### A note on `__name__`

Firestore appends the document key to every composite index, and live exports render it explicitly.
indexwright treats the implicit direction as *the `order` of the last preceding field that carries
one*, or `ASCENDING` when none does. A trailing `__name__` is stripped from the canonical key only
when it matches that direction, so `[totalNbUses DESCENDING, __name__ ASCENDING]` — which is
meaningful — is preserved and not flagged.

## Output

`text` is grouped by rule and meant for a terminal. `github` emits workflow commands plus a Markdown
table for `$GITHUB_STEP_SUMMARY`. `json` is the stable machine-readable contract:

```jsonc
{
  "version": "0.1.0",
  "files": ["firestore.indexes.json"],
  "summary": { "warnings": 1, "errors": 0, "byRule": { "scope-mismatch": 1, "…": 0 } },
  "findings": [
    {
      "rule": "scope-mismatch",
      "file": "firestore.indexes.json",
      "key": "posts::COLLECTION_GROUP::pinned:ASCENDING|createdAt:DESCENDING",
      "message": "…",
      "related": []
    }
  ],
  "errors": []
}
```

Output is deterministic: findings are sorted by file, then rule, then key, so two runs diff cleanly.

### In GitHub Actions

```yaml
- run: npx indexwright lint firestore.indexes.json --format github
```

## JavaScript API

The package also exports the rules directly. **This API is provisional and may change in any minor
release before 1.0**; only the `json` output shape carries the compatibility promise.

```js
import { lintFiles } from 'indexwright';

const result = lintFiles(['firestore.indexes.json'], { quota: 200 });
console.log(result.summary.byRule);
```

## Scope

`indexwright lint` is static analysis of declaration files only: no network access, no credentials,
no Firestore connection. Answering *is this index needed* takes the queries, which is a separate
package:

- **v0.2 — query capture, shipped.** [`@indexwright/record`](../record) runs a test suite
  with `FIRESTORE_EMULATOR_HOST` pointed at a pass-through proxy and records the `StructuredQuery`
  shapes it observes as a corpus. This is language- and framework-independent because it operates
  on the wire protocol rather than on source code.
- **v0.3 — coverage check.** Replay a captured corpus against a throwaway database with the
  candidate index set applied, and report queries that fail with `FAILED_PRECONDITION`. The oracle
  is Firestore itself; indexwright does not reimplement the undocumented matching rule.

Coverage is bounded by what actually exercises the proxy. A query no test issues is not observed,
and absence of observation is not evidence that an index is unused. That limit is inherent; the
narrower ones that are not — the Firebase Web SDK's transport, and snapshot listeners — are
[named in the spec](../../SPEC.md) and counted in the corpus rather than passed over.

## Toward 1.0

1.0 requires, at minimum: measured false-positive rates for `scope-mismatch` and
`field-order-variant` across more than one real project; at least one adopter outside the project of
origin; and a decision, informed by that data, on whether any rule should default to failing.

Until then the version stays below 1.0 and the rules stay provisional.

## Development

This is an npm workspace holding two packages under `packages/`: `indexwright` and
[`@indexwright/record`](../record). Both scripts cover both.

```bash
npm install
npm test                  # builds, then runs both suites against dist/
npm run verify-package    # builds, packs, installs each tarball, exercises the bins and the APIs
```

Both scripts build first as an explicit step rather than through a `pre` hook, because npm skips
`pre`/`post` scripts entirely under `ignore-scripts=true` — a setting many developers turn on. With
a hook, that configuration silently tests whatever `dist/` happened to be lying around.

The packages version independently and release from separate tags: `v0.2.0` publishes the linter,
`record-v0.2.0` publishes the recorder.

## License

Apache-2.0
