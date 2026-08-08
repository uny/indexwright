# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows semantic
versioning. Pre-1.0, rule additions and message changes may land in minor releases; the `json`
output shape is the stable contract.

## [0.1.1] — unreleased

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

[0.1.1]: https://github.com/uny/indexwright/releases/tag/v0.1.1
[0.1.0]: https://github.com/uny/indexwright/releases/tag/v0.1.0
