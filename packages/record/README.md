# @indexwright/record

Capture the Firestore query shapes a test suite actually issues, as a corpus.

Part of [indexwright](https://github.com/uny/indexwright). The linter reads your
`firestore.indexes.json` and can tell you that the declarations disagree with each other. It cannot
tell you whether an index is *needed* — that takes the queries, and the queries live in application
code. This is how they get collected.

> **The corpus is not evidence that an index is unused.** It records what a run exercised. A query
> no test issues is not observed, and absence of observation is not absence of the query.

## Install

```bash
npm install --save-dev @indexwright/record
```

Node.js 22 or newer. No runtime dependencies.

## Usage

Point it at your emulator and give it the command that runs your suite:

```bash
indexwright-record --emulator 127.0.0.1:8080 -- npm test
```

It starts a proxy, runs `npm test` with `FIRESTORE_EMULATOR_HOST` pointed at the proxy instead of
the emulator, and writes `firestore.queries.json`. The exit code is your suite's, so a failing suite
still fails.

```text
indexwright-record [options] -- <command> [args...]

Options:
  --emulator <host:port>  the emulator to forward to (default: $FIRESTORE_EMULATOR_HOST,
                          else 127.0.0.1:8080)
  --out <file>            where to write the corpus (default: firestore.queries.json)
  --port <n>              port for the proxy to listen on (default: chosen by the OS)
  -h, --help              show the usage
      --version           show the version
```

The proxy is transparent: bodies, trailers, and gRPC errors reach your client unchanged, and
HTTP/1.1 traffic — the emulator's REST endpoints, including the one
`@firebase/rules-unit-testing` uses to clear data — is forwarded rather than refused. A suite that
passes against the emulator passes against the proxy.

## What lands in the file

```jsonc
{
  "corpusVersion": 1,
  "queries": [
    {
      "key": "orders::COLLECTION::AND(status:EQUAL)::createdAt:DESCENDING",
      "collectionGroup": "orders",
      "queryScope": "COLLECTION",
      "where": { "op": "AND", "filters": [{ "fieldPath": "status", "op": "EQUAL" }] },
      "orderBy": [{ "fieldPath": "createdAt", "direction": "DESCENDING" }]
    }
  ],
  "skipped": []
}
```

Shape only: collection, scope, filter tree, sort order. **Values are not recorded** — they are
customer data, and a corpus is a file that gets committed. Neither are the project and database, the
`limit`, `offset`, cursors, or `select`, or how many times a query ran. Two spellings of one query
collapse to one entry, so the file is stable across runs and reviewable in a diff.

Stripping values does not make a corpus publishable. Field paths are recorded verbatim, and
`members.alice@example.com` is an ordinary way to query a map. A corpus describes your data model
and earns the access controls of the repository it lives in.

## What it does not capture

Counted in `skipped` and reported on stderr, never dropped silently — a query that was issued and
then discarded without trace would look like coverage:

| Reason | What it was |
|:--|:--|
| `listen-query` | a snapshot listener; it carries its query over `Listen`, not `RunQuery` |
| `aggregation-query` | `count()`, `sum()`, `average()` — their index requirements are not the inner query's |
| `partition-query` | `PartitionQuery`, a bulk-read entry point rather than an application query |
| `vector-query` | `find_nearest`; served by a `vectorConfig` index this version does not model |
| `unsupported-shape` | an enum value or a `from` clause the corpus vocabulary cannot name |
| `unsupported-rpc` | a query-bearing method this version does not model, including any added later |
| `unsupported-encoding` | a message compressed with something other than gzip or deflate |
| `undecodable-message` | bytes that did not parse — a defect rather than a boundary |

One gap is not a skip reason because it is a transport rather than a query: the Firebase **Web
SDK** talks WebChannel over HTTP/1.1 and carries no gRPC to read. Those requests are forwarded and
counted, and `indexwright-record` says so on stderr.

## Stability

`corpusVersion` is the contract. It names the file format, changes only when an old reader would
mis-read a new file, and does not move when this package is released. A reader handed a version it
does not know refuses the file rather than reading what it recognises.

Everything else — the CLI flags and the JavaScript API — is provisional before 1.0.

The format is specified in [SPEC.md §7](https://github.com/uny/indexwright/blob/main/SPEC.md).

## License

Apache-2.0
