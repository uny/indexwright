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
  --allow-remote-emulator forward to an emulator that is not on this host (refused by default)
  -h, --help              show the usage
      --version           show the version
```

## Both ends stay on this machine

The proxy listens on loopback, and forwards only to an address that reads as being on this machine —
reads, because nothing here resolves anything, which bounds the guarantee and is what this section
closes on. `indexwright-record` has no option to change the first — the verb has no `--host`, deliberately, since adding one in order
to guard it would be inventing the exposure. Neither constraint is a precaution against an exotic
attack; both are about what a misconfiguration costs.

The proxy performs no authentication — it is a transparent pass-through in front of an emulator that
performs none either. Reachable from off the machine, it is an open read/write channel into your
emulator's dataset for anyone who can reach the port, which on a shared CI runner is a real set of
people. And an upstream that is not the emulator you meant routes whatever documents and credentials
it holds through this process: `FIRESTORE_EMULATOR_HOST` is read from the environment, so that value
can be one nobody typed.

So an emulator that is not on this host is refused, and the message names where the address came
from. A wildcard address is not one of those: `0.0.0.0:8080` as a *destination* means this machine,
so it is a local emulator and needs nothing — it is only as a *bind* address that a wildcard is the
exposure. If you genuinely run the emulator on another host — a container in a compose file, say —
pass `--allow-remote-emulator` and it will proceed:

```sh
indexwright-record --allow-remote-emulator --emulator firestore:8080 -- npm test
```

The flag takes no value: `--allow-remote-emulator=false` is a usage error rather than a way to turn
it off, because a spelling that reads as "off" must not be the one that switches the check off.
Callers of `startCapture` have the same two opt-ins as named options, `allowRemoteUpstream` and —
since the bind address is reachable from the API even though the verb has no flag for it —
`allowRemoteBind`.

**The check reads addresses, it does not resolve names.** `localhost` is treated as loopback because
it is spelled that way — after case, a trailing dot, and brackets are normalised away, so `LOCALHOST`
and `localhost.` are the same name — and every other name is refused as though it were remote. Two
consequences are worth knowing before you rely on this. A resolver that answers `localhost` with
something other than loopback — a `nsswitch.conf` that consults DNS ahead of files, an image with no
`/etc/hosts`, a corporate wildcard domain — defeats the check, because nothing here looks. And a name
that is loopback on your machine but is not spelled `localhost` is refused: `foo.localhost`, which
RFC 6761 only *recommends* resolvers answer with loopback, or `ip6-localhost`, which is loopback
because a distribution's `/etc/hosts` says so. Give the address instead of the name — that remedy
stays correct, whereas `--allow-remote-emulator` admits the name without establishing where it
points, and a search domain or a wildcard zone can answer either of those with a routable address.
For a bind address rather than an upstream the opt-in is `allowRemoteBind: true`, which has no flag.
Verifying by resolution rather than by spelling is
[issue #24](https://github.com/uny/indexwright/issues/24).

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
