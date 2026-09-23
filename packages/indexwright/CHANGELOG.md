# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows semantic
versioning. Pre-1.0, rule additions and message changes may land in minor releases; the `json`
output shape is the stable contract.

## Unreleased

### Added

- **R5 `repeated-field-override`** (issue #54): warns when two or more `fieldOverrides` entries
  name the same `collectionGroup` and `fieldPath` and do not declare the same configuration —
  canonical override key and `ttl` together. Firestore keeps one configuration per field, and the
  Firebase CLI applies such entries in its own sort order, skipping any the live field already
  matches, so which one takes effect is decided by the deploying tool and the database's state
  rather than by the file. Entries that agree do not fire it. Its findings carry a canonical
  override key in `key` and `related`, which shares the index key's `::`-separated shape but not
  the meaning of its second part.

### Changed

- A run that selects all rules now runs five, so a file with repeated field overrides reports
  warnings it did not before, and can newly exceed `--max-warnings`.
- `RuleContext` carries `overrides`, the document's `fieldOverrides` in canonical form.

## [0.3.0] — 2026-09-21

The other half of the file. `fieldOverrides` — single-field index configuration — was typed
`unknown[]` and read by nothing; it is now validated to the same depth as `indexes` and reduced to
a canonical form, so that `@indexwright/record` 0.7.0 can reconcile a declaration against a live
field listing on the one key the linter will report on. No rule reads it yet, and nothing about the
linter's output or exit codes changes. The package also moves inside the repository, to
`packages/indexwright`, without moving anything about what is published.

### Added

- **`fieldOverrides` is validated and has a canonical form** (issues #53 and #54). The file's other
  half was typed `unknown[]` and read by nothing. It is now held to the same depth as `indexes` —
  an entry needs `collectionGroup`, `fieldPath`, and an `indexes` array (empty for an exemption),
  each index exactly one of `order`, `arrayConfig`, and `vectorConfig` (and a `queryScope`, read as
  `COLLECTION` when omitted, as the Firebase CLI does), and `ttl` a boolean when present — and `analyseOverrides` reduces each to an `AnalysedOverride` keyed as
  `<collectionGroup>::<fieldPath>::<queryScope>:<direction>|…`, sorted, with entries alike in scope and
  direction collapsed, as the set it is. No rule reads it yet; the form exists so that `@indexwright/record` can reconcile a
  declaration against a live field listing on the same key the linter will report on, rather than
  on a second model. A file whose `fieldOverrides` cannot be read that way is now malformed, where
  it previously passed unexamined. `fieldDirection` accepts any object carrying the three configs,
  which every `IndexField` still is.

### Changed

- `IndexDocument.fieldOverrides` is typed `FieldOverride[]`, no longer `unknown[]`. A consumer
  that built one by hand with entries of another shape stops compiling.
- The package now lives at `packages/indexwright` rather than at the repository root, so that
  `@indexwright/record` can depend on it from the working tree instead of from a published release.
  Nothing about the published package moves: same name, same bin, same `exports`, same
  dependency-free guarantee.
- `SPEC.md` is no longer shipped inside the tarball. It specifies both packages, so it belongs to
  the repository rather than to either one, and `files` cannot reach above a package directory. The
  alternative — copying it in at pack time — runs through `prepublishOnly`, which npm skips entirely
  under `ignore-scripts=true`; that would make the verified tarball and the published one differ in
  exactly the way `verify-package` exists to catch. The spec is linked from the README and is in the
  repository.

### Notes

- **The override key carries no marker telling it from an index key.** `posts::tags::COLLECTION:…`
  and `posts::COLLECTION::tags:…` are the same shape read by different rules, and a reader that
  does not know which listing a key came from cannot tell them apart by the string alone. Decided
  and left as it is for this release: no rule reports an override key yet and the `json` output
  does not carry one, so adding a marker later would change nothing that is a contract today, while
  adding one now would fix a spelling nothing has needed.

## [0.2.0] — 2026-08-10

### Added

- A query corpus format, specified in [SPEC.md](https://github.com/uny/indexwright/blob/main/SPEC.md) §7 and versioned by its own
  `corpusVersion` rather than by any package's release number. It is the contract between capture
  and the coverage check, and the first indexwright artefact meant to be committed and reviewed in
  a diff alongside `firestore.indexes.json`.
- `@indexwright/record`, a separate package that writes one. See
  [its changelog](https://github.com/uny/indexwright/blob/main/packages/record/CHANGELOG.md).
- `indexwright record` now says that the verb ships in `@indexwright/record` and how to run it,
  instead of reporting an unknown command. The cost of splitting the family into two packages is a
  second package to discover, and "unknown command" reads as "indexwright cannot do this".

### Changed

- SPEC §3 no longer justifies the package split with a gRPC stack for capture. Capture needs none;
  the split rests on v0.3's replay, which needs a Firestore client. Sections 7–10 shifted to 8–11
  when the corpus format was inserted as §7.

Nothing about the linter's rules, output, or exit codes changed in this release. `indexwright`
still declares no runtime dependencies, and now so does `@indexwright/record`.

## [0.1.1] — 2026-08-08

No change to the published files: this release exists to exercise the publishing path itself.

### Changed

- Released through npm trusted publishing (OIDC) rather than a long-lived access token. The token
  used to bootstrap 0.1.0 has been revoked, and the package now disallows token-based publishing
  entirely. Nothing about the package contents differs from 0.1.0 — `npm diff indexwright@0.1.0
  indexwright@0.1.1` is empty apart from the version field.

## [0.1.0] — 2026-08-07

First release. Static analysis of `firestore.indexes.json`; no network access, no credentials.

### Added

- `indexwright lint <file...>` with `--format text|json|github`, `--max-warnings`, `--rule`,
  `--disable`, `--quota`, and `--quota-threshold`.
- Rules `scope-mismatch`, `field-order-variant`, `explicit-name-field`, and `quota-headroom`. Every
  rule warns; the default exit code is 0 even with findings.
- A canonical index key that resolves declarations differing only in an explicitly written
  `__name__` to the same resource.
- A provisional JavaScript API, so the rules can run without spawning a process.

[0.3.0]: https://github.com/uny/indexwright/releases/tag/v0.3.0
[0.2.0]: https://github.com/uny/indexwright/releases/tag/v0.2.0
[0.1.1]: https://github.com/uny/indexwright/releases/tag/v0.1.1
[0.1.0]: https://github.com/uny/indexwright/releases/tag/v0.1.0
