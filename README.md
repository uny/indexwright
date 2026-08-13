# indexwright

Tooling for Firestore composite indexes: a linter for the declarations, and a recorder that captures
the queries a test suite actually issues.

The two ship as separate packages because their costs differ. The linter runs on every push, in every
CI job, in projects that may never talk to Firestore from a server, and it declares no runtime
dependency in any version. The recorder runs inside a project's own test run, where a Firestore
client is already resolved. [SPEC.md](SPEC.md) §3 states the split and what it buys.

| Package | What it does |
|:--|:--|
| [`indexwright`](packages/indexwright) | Lints `firestore.indexes.json` — four rules, no network, no credentials |
| [`@indexwright/record`](packages/record) | Captures the query shapes a suite issues, as a corpus |

[SPEC.md](SPEC.md) is the specification for both, and is the document the code cites: a comment
naming §7 means this file, not either package's README.

## Development

An npm workspace. Both scripts cover both packages.

```bash
npm install
npm test                  # builds, then runs both suites against dist/
npm run verify-package    # builds, packs, installs each tarball, exercises the bins and the APIs
```

Both build first as an explicit step rather than through a `pre` hook, because npm skips
`pre`/`post` scripts entirely under `ignore-scripts=true` — a setting many developers turn on. With
a hook, that configuration silently tests whatever `dist/` happened to be lying around.

The packages version independently and release from separate tags: `v0.2.0` publishes the linter,
`record-v0.2.0` publishes the recorder.

## License

Apache-2.0. See [LICENSE](LICENSE).
