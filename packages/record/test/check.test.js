import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AdminError,
  buildCorpus,
  check,
  DEFAULT_SETTLE_MS,
  serialiseCorpus,
  toQueryShape,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

const COMMAND = {
  kind: 'check',
  project: 'indexwright-probe',
  database: '(default)',
  corpus: 'firestore.queries.json',
  indexes: 'firestore.indexes.json',
  requireIdentity: false,
};

const DECLARED = {
  indexes: [
    {
      collectionGroup: 'orders',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'total', order: 'DESCENDING' },
      ],
    },
  ],
};

/** The live listing that reconciles as identical to `DECLARED`, with the document key written out. */
const READY = [
  {
    name: 'projects/indexwright-probe/databases/(default)/collectionGroups/orders/indexes/ix',
    state: 'READY',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'total', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  },
];

const equals = (fieldPath) => ({ fieldPath, op: 'EQUAL' });

function corpusOf(...wheres) {
  const shapes = wheres.map((where) =>
    toQueryShape({ collectionGroup: 'orders', queryScope: 'COLLECTION', where, orderBy: [] }),
  );
  return serialiseCorpus(buildCorpus(shapes, []));
}

/** `ONE_QUERY`, but produced by `producers`. */
function producedBy(...producers) {
  return serialiseCorpus(
    buildCorpus(
      [toQueryShape({ collectionGroup: 'orders', queryScope: 'COLLECTION', where: { op: 'AND', filters: [equals('status')] }, orderBy: [] })],
      [],
      producers,
    ),
  );
}

const ONE_QUERY = corpusOf({ op: 'AND', filters: [equals('status')] });

/**
 * The verb with every seam filled, and a clock that does not tick unless the verb sleeps.
 *
 * The settling period is a minute by design, so a test that waited it out could not pin the gate at
 * all. Here `sleep` *is* the clock: time passes only where the verb asked it to, which also makes
 * every wait the verb takes visible to the test rather than merely slow.
 */
const BASELINE_PATH = 'firestore.accepted.json';

/** A baseline file naming `keys`, each with a reason, in the shape the reader accepts. */
function baselineOf(...keys) {
  return JSON.stringify({
    baselineVersion: 1,
    accepted: keys.map((key) => ({ key, reason: `accepted while #101 is open` })),
  });
}

/** The §7 key for a single-EQUAL query on `field`, which is what `corpusOf` builds. */
function keyOf(field) {
  return toQueryShape({
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    where: { op: 'AND', filters: [equals(field)] },
    orderBy: [],
  }).key;
}

function harness({ listings = [READY], statuses = [], corpus = ONE_QUERY, declared = DECLARED, baseline, requireIdentity = false, ...rest } = {}) {
  const said = [];
  const closed = { lister: 0, replayer: 0 };
  const replayed = [];
  const slept = [];
  let clock = 0;
  const queue = [...listings];
  const outcomes = [...statuses];

  const options = {
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    readFile: (path) => {
      if (path === COMMAND.indexes) return JSON.stringify(declared);
      if (path === COMMAND.corpus) return corpus;
      if (baseline !== undefined && path === BASELINE_PATH) return baseline;
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    },
    lister: async () => ({
      listIndexesAsync() {
        // The last listing repeats, so a test that only cares about the settled state says it once.
        const live = queue.length > 1 ? queue.shift() : queue[0];
        if (live instanceof Error) throw live;
        return (async function* () {
          for (const index of live) yield index;
        })();
      },
      close: async () => {
        closed.lister += 1;
      },
    }),
    replayer: async () => ({
      run: async (plan) => {
        replayed.push(plan);
        return outcomes.shift() ?? { kind: 'served' };
      },
      close: async () => {
        closed.replayer += 1;
      },
    }),
    ...rest,
  };

  const streams = { out: () => {}, err: (text) => said.push(text) };
  return {
    closed,
    replayed,
    slept,
    said: () => said.join(''),
    run: () =>
      check(
        {
          ...COMMAND,
          requireIdentity,
          ...(baseline === undefined ? {} : { baseline: BASELINE_PATH }),
        },
        streams,
        options,
      ),
  };
}

test('a corpus the candidate set covers exits 0, having asked the target about every entry', async () => {
  const h = harness();
  assert.equal(await h.run(), 0);
  assert.equal(h.replayed.length, 1);
  assert.match(h.said(), /1 query replayed, 0 not served/);
});

test('a query the candidate set cannot serve is the finding, and exits 1', async () => {
  // Unlike `lint`, which defaults to exit 0 because its rules have unmeasured false-positive rates,
  // the oracle here is Firestore itself. A FAILED_PRECONDITION is worth failing a pipeline on.
  const h = harness({ statuses: [{ kind: 'uncovered', message: '"the query requires an index"' }] });
  assert.equal(await h.run(), 1);
  assert.match(h.said(), /not served: "orders::COLLECTION/);
  assert.match(h.said(), /the query requires an index/);
  assert.match(h.said(), /1 query replayed, 1 not served/);
});

test('one observation can never establish readiness, however ready it looks', async () => {
  // The failure the settling period guards against is precisely a set that looks ready at one
  // instant: a composite index answers FAILED_PRECONDITION for a period after it can already serve
  // some queries, and reporting inside that window emits the false positive §2 forbids acting on.
  const h = harness();
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.slept, [DEFAULT_SETTLE_MS]);
});

test('a set that changes under the settling period starts it again', async () => {
  // An index appearing or disappearing is a transition as much as a state change is, and a period
  // that survived one would be timing the wrong set.
  const other = [{ ...READY[0], name: `${READY[0].name}-2` }];
  const h = harness({ listings: [READY, other, READY, READY] });
  assert.equal(await h.run(), 0);
  // Three waits rather than the one above: each change restarted the run of all-READY observations.
  assert.deepEqual(h.slept, [DEFAULT_SETTLE_MS, DEFAULT_SETTLE_MS, DEFAULT_SETTLE_MS]);
});

test('an index still building is waited on, and one that will never build is not', async () => {
  const building = [{ ...READY[0], state: 'CREATING' }];
  const waiting = harness({ listings: [building, READY, READY] });
  assert.equal(await waiting.run(), 0);
  assert.match(waiting.said(), /waiting: 1 index still building/);

  // NEEDS_REPAIR and a state this version cannot name are both outcomes waiting does not resolve, so
  // polling on them would spend the whole deadline to arrive at the same answer.
  // Pinned apart rather than together: `/readiness could not be established/` is the prefix
  // `establishReadiness`'s caller prepends, so it matches whichever verdict `describe` produced —
  // and the `unrecognised` arm is the only place the unknown state name reaches the operator.
  for (const [state, expected] of [
    ['NEEDS_REPAIR', /1 index in NEEDS_REPAIR, which waiting does not resolve/],
    ['DEFRAGMENTING', /1 index in a state this version cannot classify \("DEFRAGMENTING"\)/],
  ]) {
    const stuck = harness({ listings: [[{ ...READY[0], state }]] });
    assert.equal(await stuck.run(), 2);
    assert.match(stuck.said(), /readiness could not be established/);
    assert.match(stuck.said(), expected);
    assert.deepEqual(stuck.slept, []);
  }
});

test('a build that never finishes ends the run rather than the runner', async () => {
  // An unbounded poll is the wrong default for a command a CI job runs: the job would occupy a
  // runner rather than report a problem.
  const h = harness({
    listings: [[{ ...READY[0], state: 'CREATING' }]],
    pollMs: 5_000,
    deadlineMs: 20_000,
  });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /readiness could not be established: 1 index still building/);
  assert.match(h.said(), /this run has waited 20s/);
  assert.equal(h.replayed.length, 0);
});

test('a listing that failed is not a listing, and no replay follows it', async () => {
  // SPEC §3: a principal that cannot list indexes must be told readiness could not be established.
  // Falling back to `[]` would reconcile every declaration as missing — a confident divergence.
  const h = harness({ listings: [new Error('PERMISSION_DENIED')] });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /readiness could not be established/);
  assert.equal(h.replayed.length, 0);
  assert.equal(h.closed.lister, 1);
  assert.equal(h.closed.replayer, 0);
});

test('a target that does not hold the candidate set is not replayed against', async () => {
  // The quiet failure is the extra one: a target holding an index the file does not declare serves
  // queries the candidate set alone would not, so the run comes back clean and the gap never appears.
  const extra = [
    ...READY,
    {
      name: 'projects/indexwright-probe/databases/(default)/collectionGroups/carts/indexes/ix',
      state: 'READY',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'owner', order: 'ASCENDING' },
        { fieldPath: '__name__', order: 'ASCENDING' },
      ],
    },
  ];
  const h = harness({ listings: [extra] });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /cannot report: the target does not hold the candidate index set/);
  assert.match(h.said(), /on the target but not declared: "carts::COLLECTION/);
  assert.equal(h.replayed.length, 0);
});

test('an entry that cannot be replayed makes the report incomplete rather than clean', async () => {
  // A root OR with no children was on the wire and matches nothing. Omitting the `where` would issue
  // an *unfiltered* query, which needs no index, succeeds, and reports the entry covered.
  const corpus = JSON.stringify({
    corpusVersion: 1,
    queries: [
      {
        key: 'orders::COLLECTION::OR()::',
        collectionGroup: 'orders',
        queryScope: 'COLLECTION',
        where: { op: 'OR', filters: [] },
        orderBy: [],
      },
    ],
    skipped: [],
  });
  const h = harness({ corpus });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /cannot replay:/);
  assert.equal(h.replayed.length, 0);
  // Every entry in this corpus is the unreplayable one, so there is nothing left to ask the target
  // about — and the run says so instead of spending a settling period to arrive at the same line.
  assert.match(h.said(), /no entry in the corpus .* has a replayable form/);
  assert.deepEqual(h.slept, []);
});

test('a corpus with one replayable entry beside an unreplayable one still asks about the one', async () => {
  const corpus = JSON.parse(ONE_QUERY);
  corpus.queries.push({
    key: 'orders::COLLECTION::OR()::',
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    where: { op: 'OR', filters: [] },
    orderBy: [],
  });
  corpus.queries.sort((a, b) => (a.key < b.key ? -1 : 1));
  const h = harness({ corpus: JSON.stringify(corpus) });
  assert.equal(await h.run(), 2);
  assert.equal(h.replayed.length, 1);
  assert.match(h.said(), /1 query replayed, 0 not served/);
  // The entry that could not be replayed is why: a report missing an entry is not a clean one.
  assert.match(h.said(), /this report is incomplete/);
});

test('a corpus entry the SDK cannot name a field from is reported, not thrown', async () => {
  // The wire backtick-quotes any segment that is not a plain name, so `where('first-name', ...)` is
  // recorded as `` `first-name` ``. The SDK's string form reads the dots and not the backticks, so
  // replaying it would filter on a *differently named field* and report a FAILED_PRECONDITION for a
  // query nobody issued. Refused — and refused during planning, so the run says so before it spends
  // the settling minute, and exits 2 rather than dying with an uncaught ReplayError.
  const shape = toQueryShape({
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    where: { op: 'AND', filters: [{ fieldPath: 'user.`first-name`', op: 'EQUAL' }] },
    orderBy: [],
  });
  const h = harness({ corpus: serialiseCorpus(buildCorpus([shape], [])) });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /cannot replay: .*is quoted/);
  assert.equal(h.replayed.length, 0);
  assert.deepEqual(h.slept, []);
});

test('an order clause names a field too, and is refused on the same rule', async () => {
  const shape = toQueryShape({
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    where: { op: 'AND', filters: [equals('status')] },
    orderBy: [{ fieldPath: 'a..b', direction: 'ASCENDING' }],
  });
  const h = harness({ corpus: serialiseCorpus(buildCorpus([shape], [])) });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /cannot replay: .*has an empty segment/);
});

test('a collection id carrying a path is refused rather than measured somewhere else', async () => {
  // `db.collection('users/u1/orders')` is not an error: the SDK reads it as a path and hands back
  // the subcollection at it. The run would then replay against a collection the corpus never named
  // and report the verdict as though it were about the recorded one — a wrong answer with nothing
  // about it that looks wrong, which is the one outcome §2 forbids most strictly.
  const shape = toQueryShape({
    collectionGroup: 'users/u1/orders',
    queryScope: 'COLLECTION',
    where: { op: 'AND', filters: [equals('status')] },
    orderBy: [],
  });
  const h = harness({ corpus: serialiseCorpus(buildCorpus([shape], [])) });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /cannot replay: .*contains a '\/'/);
  assert.equal(h.replayed.length, 0);
});

test('a plan that reaches the target unbuildable is reported, and does not end the run', async () => {
  // The backstop behind the plan-time refusals: if the two ever disagree, the entry has no verdict
  // and says so, while the entries around it still get one. Before, it left as an uncaught
  // rejection — and a run that had already found a real FAILED_PRECONDITION lost that too.
  const h = harness({
    corpus: corpusOf({ op: 'AND', filters: [equals('a')] }, { op: 'AND', filters: [equals('b')] }),
    statuses: [
      { kind: 'unbuildable', message: '"the field path is quoted"' },
      { kind: 'uncovered', message: '"the query requires an index"' },
    ],
  });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /cannot replay: .*the field path is quoted/);
  assert.match(h.said(), /not served:/);
  // One replayed, not two: an entry the target never answered for is not a query that was replayed.
  assert.match(h.said(), /1 query replayed, 1 not served/);
  assert.match(h.said(), /this report is incomplete/);
});

test('a path that could forge a report line is rendered before it reaches the stream', async () => {
  // `requirePath` constrains a path only to being non-empty and not starting with `-`, so a newline
  // survives it. Every other operator-facing string on this stream is rendered; these were not, and
  // `--indexes` reaches the *success* line, so the forged line landed in an otherwise clean report.
  const corpus = 'firestore.queries.json\nindexwright-record: 9 queries replayed, 0 not served';
  const said = [];
  const code = await check(
    { ...COMMAND, corpus },
    { out: () => {}, err: (text) => said.push(text) },
    {
      // The candidate file reads; the corpus is the one that fails, so the run reaches the line
      // that names it and stops there. No client is built.
      readFile: (path) => {
        if (path === COMMAND.indexes) return JSON.stringify(DECLARED);
        throw new Error('ENOENT: no such file or directory');
      },
      lister: async () => assert.fail('no client should be built on this path'),
    },
  );
  assert.equal(code, 2);
  const lines = said.join('').trimEnd().split('\n');
  assert.equal(lines.length, 1, `forged a second line: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /could not read the corpus at .*\\u000a/);
});

test('an empty corpus is refused rather than reported as full coverage', async () => {
  // It replays cleanly by construction, so exit 0 would say the candidate set covers everything
  // having measured nothing. A suite driven through the Firebase Web SDK really does produce one.
  const h = harness({ corpus: JSON.stringify({ corpusVersion: 1, queries: [], skipped: ['listen-query'] }) });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /the corpus at .* holds no queries/);
  assert.equal(h.replayed.length, 0);
});

test('an INVALID_ARGUMENT is not a verdict about the index set', async () => {
  const h = harness({ statuses: [{ kind: 'invalid', message: '"inequality on two fields"' }] });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /invalid when replayed, which is not a verdict about the index set/);
  assert.match(h.said(), /this report is incomplete/);
});

test('a status the run cannot read stops it, rather than repeating itself down the corpus', async () => {
  const h = harness({
    corpus: corpusOf(
      { op: 'AND', filters: [equals('a')] },
      { op: 'AND', filters: [equals('b')] },
      { op: 'AND', filters: [equals('c')] },
    ),
    statuses: [{ kind: 'served' }, { kind: 'failed', message: '"PERMISSION_DENIED"' }],
  });
  assert.equal(await h.run(), 2);
  // A missing permission is almost never about the one entry that met it, so the remaining entries
  // would meet the same wall and the report would be a page of identical failures.
  assert.equal(h.replayed.length, 2);
  assert.match(h.said(), /stopped: the target answered with a status this run cannot read/);
  // Two rather than three: the count is what was asked, not what the corpus held, so a report that
  // stopped early cannot read as one that got to the end.
  assert.match(h.said(), /2 queries replayed/);
});

test('an incomplete report outranks a clean-looking one, so exit 1 means "these and no others"', async () => {
  const h = harness({
    corpus: corpusOf({ op: 'AND', filters: [equals('a')] }, { op: 'AND', filters: [equals('b')] }),
    statuses: [
      { kind: 'uncovered', message: '"needs an index"' },
      { kind: 'invalid', message: '"bad"' },
    ],
  });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /not served:/);
  assert.match(h.said(), /this report is incomplete/);
});

test('both clients are released on every path out, including the ones that fail', async () => {
  // A live gRPC channel refs the event loop, so a client nobody closes turns a completed run into a
  // process that printed its report and then sat there (issue #39).
  // Two listers on a run that reaches the end: one for the readiness gate, one for the confirmation
  // that the set was still there when the last query was answered (issue #44).
  const clean = harness();
  assert.equal(await clean.run(), 0);
  assert.deepEqual(clean.closed, { lister: 2, replayer: 1 });

  const stopped = harness({ statuses: [{ kind: 'failed', message: '"gone"' }] });
  assert.equal(await stopped.run(), 2);
  assert.deepEqual(stopped.closed, { lister: 2, replayer: 1 });

  // A rejection rather than a status: nothing here catches it, and the client still has to be let
  // go of on the way past.
  let released = 0;
  const thrown = harness({
    replayer: async () => ({
      run: async () => {
        throw new Error('the connection went away mid-replay');
      },
      close: async () => {
        released += 1;
      },
    }),
  });
  await assert.rejects(thrown.run(), /went away/);
  assert.equal(released, 1);
  assert.equal(thrown.closed.lister, 1);
});

test('a client that will not close does not replace the answer the run reached', async () => {
  // A `finally` that throws discards what the block was carrying — the report about to be printed,
  // or the decline being raised — and leaves a rejection naming nothing anyone asked about. That is
  // the shape issue #41 fixed on the decline path, and closing a client is the other place it lives.
  const reporting = harness({
    statuses: [{ kind: 'uncovered', message: '"needs an index"' }],
    replayer: async () => ({
      run: async () => ({ kind: 'uncovered', message: '"needs an index"' }),
      close: async () => {
        throw new Error('the channel would not close');
      },
    }),
  });
  assert.equal(await reporting.run(), 1);
  assert.match(reporting.said(), /not served:/);
  // Said rather than swallowed: a channel that would not close is the likeliest explanation for a
  // run that then does not exit.
  assert.match(reporting.said(), /could not release the replay client/);

  // No `listings` here: `harness` spreads `...rest` last, so an explicit `lister` overwrites the
  // queue-driven one and a `listings` beside it would be inert — an argument a later reader would
  // edit to change the scenario and see no effect.
  const damaged = { ...READY[0], state: 'NEEDS_REPAIR' };
  const declining = harness({
    lister: async () => ({
      listIndexesAsync: () => (async function* () {
        yield damaged;
      })(),
      close: async () => {
        throw new Error('the channel would not close');
      },
    }),
  });
  assert.equal(await declining.run(), 2);
  assert.match(declining.said(), /readiness could not be established: 1 index in NEEDS_REPAIR/);
  assert.match(declining.said(), /could not release the index lister/);
});

test('a set that changed while the queries were answered withdraws the report, whichever way it read', async () => {
  // Both gates read the set once, before the first replayed query, so a run vouches for a set at one
  // moment and reports about a window that starts there (issue #44). The third listing is the one
  // that looks again: `harness` repeats the last entry, so `[READY, READY, X]` settles on READY and
  // confirms against X.
  //
  // An index removed mid-run is the false positive §2 forbids acting on: the query that needed it
  // answers `FAILED_PRECONDITION`, which would be reported as a coverage gap in a candidate set that
  // does not have one.
  const removed = harness({
    listings: [READY, READY, []],
    statuses: [{ kind: 'uncovered', message: '"needs an index"' }],
  });
  assert.equal(await removed.run(), 2);
  assert.match(removed.said(), /the index set changed while the queries were being answered/);
  assert.match(removed.said(), /declared but not on the target:/);

  // An index added mid-run is the quiet one: the query is served by a declaration the candidate set
  // does not carry, and the run would otherwise exit 0 having reported coverage the candidate set
  // alone does not provide.
  const undeclared = {
    ...READY[0],
    name: 'projects/indexwright-probe/databases/(default)/collectionGroups/orders/indexes/added',
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'placed', order: 'ASCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' },
    ],
  };
  const added = harness({ listings: [READY, READY, [...READY, undeclared]] });
  assert.equal(await added.run(), 2);
  assert.match(added.said(), /the index set changed while the queries were being answered/);
  assert.match(added.said(), /on the target but not declared:/);
});

test('the confirmation withdraws a verdict and never replaces one, so it cannot turn 1 into 0', async () => {
  // It looks at the index set and not at coverage, so there is no reading of it that improves an
  // answer. The same uncovered corpus exits 1 when the set held and 2 when it did not — never 0.
  const held = harness({ statuses: [{ kind: 'uncovered', message: '"needs an index"' }] });
  assert.equal(await held.run(), 1);
  assert.match(held.said(), /1 query replayed, 1 not served/);

  const moved = harness({
    listings: [READY, READY, []],
    statuses: [{ kind: 'uncovered', message: '"needs an index"' }],
  });
  assert.equal(await moved.run(), 2);
  // The coverage line is not printed at all: there is no report to caveat, which is the distinction
  // between declining and reporting with a warning.
  assert.doesNotMatch(moved.said(), /not served by the candidate set/);
});

test('a confirmation that could not be made is not a confirmation', async () => {
  // Declining here costs a run that was probably fine. Not declining reports a verdict nothing
  // stands behind, and §2 ranks those the other way round.
  let built = 0;
  const h = harness({
    lister: async () => {
      built += 1;
      if (built > 1) throw new AdminError('the listing call was refused');
      return {
        listIndexesAsync: () => (async function* () {
          for (const index of READY) yield index;
        })(),
        close: async () => {},
      };
    },
  });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /could not be listed again after replay: the listing call was refused/);
  assert.doesNotMatch(h.said(), /1 query replayed/);
});

test('a withdrawal takes away the verdict and not the entries the run had no answer for', async () => {
  // The lines naming an unanswered entry are not the report. A credential that dies mid-run halts
  // the replay *and* moves — or refuses — the second listing, so the case where these lines are the
  // only explanation of the failure is exactly the case that used to lose them.
  const halted = harness({
    listings: [READY, READY, []],
    statuses: [{ kind: 'failed', message: '"PERMISSION_DENIED"' }],
  });
  assert.equal(await halted.run(), 2);
  assert.match(halted.said(), /stopped: the target answered with a status this run cannot read/);
  assert.match(halted.said(), /"PERMISSION_DENIED"/);
  assert.match(halted.said(), /the index set changed while the queries were being answered/);

  // Same for an entry the target refused as invalid: not a verdict about the index set, and so not
  // something the withdrawal of that verdict should carry off with it.
  const refused = harness({
    listings: [READY, READY, []],
    statuses: [{ kind: 'invalid', message: '"INVALID_ARGUMENT"' }],
  });
  assert.equal(await refused.run(), 2);
  assert.match(refused.said(), /invalid when replayed, which is not a verdict about the index set/);
});

test('a set that could not be compared again is not reported as a set that changed', async () => {
  // `reconcile` refuses a live entry it cannot read, and the declaration it leaves unmatched is
  // reported as `missing` — which reads exactly like a deleted index and is not one. The set may
  // have held and simply been described in terms this run could not compare, and asserting a change
  // on that evidence is this confirmation's own failure pointed the other way.
  const unreadable = harness({ listings: [READY, READY, [{ ...READY[0], fields: null }]] });
  assert.equal(await unreadable.run(), 2);
  assert.match(unreadable.said(), /the index set could not be compared again after the queries were answered/);
  assert.doesNotMatch(unreadable.said(), /the index set changed/);
  assert.match(unreadable.said(), /could not be read \(fields-missing\)/);

  // An index genuinely gone still says so, so the distinction is a reading of the evidence rather
  // than a softening of every decline.
  const gone = harness({ listings: [READY, READY, []] });
  assert.equal(await gone.run(), 2);
  assert.match(gone.said(), /the index set changed while the queries were being answered/);

  // And an unreadable entry does not launder a change that is visible beside it. An `extra` was read
  // well enough to be keyed, so nothing about it is in doubt, and leading with "could not be
  // compared" over the top of it would understate the line printed underneath.
  const alsoAdded = harness({
    listings: [
      READY,
      READY,
      [
        { ...READY[0], fields: null },
        {
          ...READY[0],
          name: 'projects/indexwright-probe/databases/(default)/collectionGroups/orders/indexes/added',
          fields: [
            { fieldPath: 'status', order: 'ASCENDING' },
            { fieldPath: 'placed', order: 'ASCENDING' },
            { fieldPath: '__name__', order: 'ASCENDING' },
          ],
        },
      ],
    ],
  });
  assert.equal(await alsoAdded.run(), 2);
  assert.match(alsoAdded.said(), /the index set changed while the queries were being answered/);
  assert.match(alsoAdded.said(), /on the target but not declared:/);
  assert.match(alsoAdded.said(), /could not be read \(fields-missing\)/);
});

test('the confirmation lister is released when the second listing is refused, not only when it is built', async () => {
  // The realistic refusal is PERMISSION_DENIED at list time, which `listLiveIndexes` wraps — and by
  // then the client exists. Pinned separately because the factory-throws case never reaches the
  // `finally` at all: with the release moved out of it the whole suite stayed green, and a run that
  // printed its decline and then sat there holding a ref'd channel is issue #39 exactly.
  const refused = harness({ listings: [READY, READY, new Error('PERMISSION_DENIED')] });
  assert.equal(await refused.run(), 2);
  assert.deepEqual(refused.closed, { lister: 2, replayer: 1 });
  assert.match(refused.said(), /could not be listed again after replay: .*PERMISSION_DENIED/);
});

test('the lister is closed before the replay client is built, so one channel is open at a time', async () => {
  const order = [];
  const h = harness({
    lister: async () => {
      // Pushed only from the second construction on, so the list reads as the sequence the test is
      // about rather than opening with a step the original invariant never had.
      if (order.length > 0) order.push('lister built');
      return {
        listIndexesAsync() {
          return (async function* () {
            for (const index of READY) yield index;
          })();
        },
        close: async () => order.push('lister closed'),
      };
    },
    replayer: async () => {
      order.push('replayer built');
      return { run: async () => ({ kind: 'served' }), close: async () => order.push('replayer closed') };
    },
  });
  assert.equal(await h.run(), 0);
  // The confirmation adds a fourth step and does not add a fourth *channel*: the replay client is
  // released before the second lister is built, so the invariant this test is named for survives the
  // extra listing rather than being traded for it.
  assert.deepEqual(order, [
    'lister closed',
    'replayer built',
    'replayer closed',
    'lister built',
    'lister closed',
  ]);
});

test('the files are read before any client is built, so a typo costs no settling period', async () => {
  // Everything up to the first client is offline and costs milliseconds; everything after it costs a
  // minute of settling at the least.
  let built = 0;
  const h = harness({
    readFile: () => {
      throw new Error("ENOENT: no such file or directory, open 'firestore.indexes.json'");
    },
    lister: async () => {
      built += 1;
      throw new Error('should not be reached');
    },
  });
  assert.equal(await h.run(), 2);
  assert.equal(built, 0);
  assert.equal(h.slept.length, 0);
  assert.match(h.said(), /could not read the candidate indexes/);
});

test('what a file refused to parse cannot forge a line of output', async () => {
  // A corpus and a candidate index file are committed artefacts this machine did not necessarily
  // author, and both parsers quote the offending source when they refuse it.
  const h = harness({
    readFile: (path) => {
      if (path === COMMAND.indexes) return JSON.stringify(DECLARED);
      return '{"corpusVersion": 1, "queries": "\\nindexwright-record: target elsewhere", "skipped": []}';
    },
  });
  assert.equal(await h.run(), 2);
  const lines = h.said().trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not read the corpus/);
});

test('a run that has reported lets the process exit', async () => {
  // The unit tests above pin that `close` is called. This pins what calling it is *for*, which no
  // fake can express in-process: a handle that refs the event loop keeps the run alive after the
  // report, and a CI step that hangs having printed a successful report is a worse failure than one
  // that errors (issue #39). The fake's clients hold a real ref'd handle and release it in `close`,
  // so a verb that forgot would leave this child running rather than fail an assertion.
  const script = `
    import { check } from ${JSON.stringify(pathToFileURL(join(here, '..', 'dist', 'index.js')).href)};
    const holding = () => {
      const handle = setInterval(() => {}, 1000);
      return async () => clearInterval(handle);
    };
    const live = ${JSON.stringify(READY)};
    await check(${JSON.stringify(COMMAND)}, { out() {}, err() {} }, {
      settleMs: 0,
      readFile: (path) => path === ${JSON.stringify(COMMAND.indexes)}
        ? ${JSON.stringify(JSON.stringify(DECLARED))}
        : ${JSON.stringify(ONE_QUERY)},
      sleep: async () => {},
      lister: async () => ({
        listIndexesAsync: () => (async function* () { for (const i of live) yield i; })(),
        close: holding(),
      }),
      replayer: async () => ({ run: async () => ({ kind: 'served' }), close: holding() }),
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const [code, signal] = await once(child, 'close');
  clearTimeout(timer);
  assert.equal(signal, null, 'the run had to be killed: something it opened was never released');
  assert.equal(code, 0);
});

test('a gap in the baseline is reported in the same words, and does not fail the run', async () => {
  // The point of issue #57: a project of any age finds all of its existing gaps in one run, and a
  // check it cannot adopt without closing every one of them first goes in behind `|| true`.
  const h = harness({
    baseline: baselineOf(keyOf('status')),
    statuses: [{ kind: 'uncovered', message: '"the query requires an index"' }],
  });
  assert.equal(await h.run(), 0);
  // Still "not served". SPEC §2 is about what may be claimed, and deciding to live with a gap
  // claims nothing about the index being unnecessary — so the lead does not soften.
  assert.match(h.said(), /not served: "orders::COLLECTION/);
  assert.match(h.said(), /in the baseline, so this does not fail the run: "accepted while #101 is open"/);
  // And the summary cannot be read as a run that found nothing.
  assert.match(h.said(), /1 query replayed, 1 not served by the candidate set, 1 of them in the baseline/);
});

test('a gap the baseline does not name is still the finding, alongside one it does', async () => {
  const h = harness({
    corpus: corpusOf({ op: 'AND', filters: [equals('a')] }, { op: 'AND', filters: [equals('b')] }),
    baseline: baselineOf(keyOf('a')),
    statuses: [
      { kind: 'uncovered', message: '"needs an index"' },
      { kind: 'uncovered', message: '"needs an index"' },
    ],
  });
  assert.equal(await h.run(), 1);
  assert.match(h.said(), /2 queries replayed, 2 not served by the candidate set, 1 of them in the baseline/);
});

test('a baseline matches on the canonical key exactly, so a new gap cannot inherit an old one', async () => {
  // §7 keys are canonical and unique within a corpus. Anything looser would let a gap be accepted
  // for resembling one somebody once justified.
  const h = harness({
    baseline: baselineOf(`${keyOf('status')}::`),
    statuses: [{ kind: 'uncovered', message: '"needs an index"' }],
  });
  assert.equal(await h.run(), 1);
  assert.doesNotMatch(h.said(), /so this does not fail the run/);
});

test('a baseline entry that is now served is reported, so the file shrinks as gaps are closed', async () => {
  const h = harness({ baseline: baselineOf(keyOf('status')) });
  assert.equal(await h.run(), 0);
  assert.match(h.said(), /in the baseline, but served: "orders::COLLECTION/);
});

test('a baseline entry the corpus no longer holds is reported before any client is built', async () => {
  // It is answered by the corpus alone, so it costs no settling period — and no verdict this run
  // might later withdraw can change it.
  const h = harness({ baseline: baselineOf('orders::COLLECTION::AND(gone:EQUAL)::') });
  assert.equal(await h.run(), 0);
  assert.match(h.said(), /in the baseline, but the corpus no longer holds it: "orders::COLLECTION::AND\(gone:EQUAL\)::"/);
});

test('an entry the run never got a verdict for is not reported as one that stopped reproducing', async () => {
  // The run halts on the first status it cannot read, so the second entry is never asked about.
  // Calling its baseline entry stale would shrink the file by a gap nobody measured — §2's false
  // clean in miniature, and the gap would come back as a finding the next time it is reached.
  const h = harness({
    corpus: corpusOf({ op: 'AND', filters: [equals('a')] }, { op: 'AND', filters: [equals('b')] }),
    baseline: baselineOf(keyOf('b')),
    statuses: [{ kind: 'failed', message: '"PERMISSION_DENIED"' }],
  });
  assert.equal(await h.run(), 2);
  assert.doesNotMatch(h.said(), /in the baseline, but/);
});

test('a baseline that cannot be read is a run that cannot answer, found before the settling period', async () => {
  const unreadable = harness({ baseline: '{"baselineVersion":1,"accepted":[{"key":"k"}]}' });
  assert.equal(await unreadable.run(), 2);
  assert.match(unreadable.said(), /could not read the baseline at "firestore\.accepted\.json"/);
  assert.match(unreadable.said(), /accepted\[0\] is missing reason/);
  assert.equal(unreadable.slept.length, 0);
  assert.equal(unreadable.replayed.length, 0);
});

test('a baseline reason cannot forge a line of output', async () => {
  // The file is a committed artefact this machine did not necessarily author, and the reason is
  // printed verbatim on every run that matches it.
  const h = harness({
    baseline: JSON.stringify({
      baselineVersion: 1,
      accepted: [{ key: keyOf('status'), reason: 'ok\nindexwright-record: 1 query replayed, 0 not served' }],
    }),
    statuses: [{ kind: 'uncovered', message: '"needs an index"' }],
  });
  assert.equal(await h.run(), 0);
  assert.doesNotMatch(h.said(), /\nindexwright-record: 1 query replayed, 0 not served/);
  assert.match(h.said(), /"ok\\u000aindexwright-record: 1 query replayed, 0 not served"/);
});

test('the baseline does not survive a withdrawal, because the verdict it changed does not either', async () => {
  // "In the baseline, but served" is a statement that a query *was* served, which is exactly what a
  // set that moved mid-run makes untrue.
  // `harness` repeats the last entry, so `[READY, READY, []]` settles on READY and confirms
  // against a target that no longer holds the index.
  const h = harness({ baseline: baselineOf(keyOf('status')), listings: [READY, READY, []] });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /the index set changed while the queries were being answered/);
  assert.doesNotMatch(h.said(), /in the baseline, but served/);
});

test('a corpus that measured nothing does not ask for the baseline to be shrunk', async () => {
  // The refusal above it is the whole reason: a suite driven through the Firebase Web SDK issues no
  // gRPC, so `record` writes a corpus with no queries. A run that then named every accepted gap as
  // one the corpus no longer holds would be asking an operator to delete gaps on the strength of a
  // run that replayed nothing — §2's false clean arriving through the corpus rather than the target,
  // and every deleted entry comes back as a finding the next time a corpus is really recorded.
  const h = harness({
    corpus: JSON.stringify({ corpusVersion: 1, queries: [], skipped: ['listen-query'] }),
    baseline: baselineOf(keyOf('status')),
  });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /the corpus at .* holds no queries/);
  assert.doesNotMatch(h.said(), /the corpus no longer holds it/);
});

test('a baselined entry the corpus holds but cannot plan is not called stale either', async () => {
  // `keys` is filled before the plan is attempted, and this is the case that says why: the corpus
  // holds the query, so it has not stopped reproducing — the run simply has no replayable form for
  // it. Reporting it as stale would shrink the file by an entry that was never measured.
  const unplannable = toQueryShape({
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    where: { op: 'AND', filters: [equals('a..b')] },
    orderBy: [],
  });
  // Paired with a replayable entry on purpose: a corpus that plans nothing at all is refused
  // before any of this is reached, so the entry has to sit in a run that really does replay.
  const plannable = toQueryShape({
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    where: { op: 'AND', filters: [equals('status')] },
    orderBy: [],
  });
  const h = harness({
    corpus: serialiseCorpus(buildCorpus([unplannable, plannable], [])),
    baseline: baselineOf(unplannable.key),
  });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /cannot replay: .*has an empty segment/);
  assert.doesNotMatch(h.said(), /in the baseline, but/);
});

test('a stale corpus entry is named even by a run whose verdict is withdrawn', async () => {
  // It is answered by the corpus alone, so unlike `in the baseline, but served` it is not part of
  // the report and does not go with it. `[READY, READY, []]` settles on READY and then confirms
  // against a target that no longer holds the index, which withdraws the verdict.
  const h = harness({
    baseline: baselineOf('orders::COLLECTION::AND(gone:EQUAL)::'),
    listings: [READY, READY, []],
  });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /the index set changed while the queries were being answered/);
  assert.match(h.said(), /in the baseline, but the corpus no longer holds it: "orders::COLLECTION::AND\(gone:EQUAL\)::"/);
});

test('a gap that is still a gap is never also reported as one that stopped reproducing', async () => {
  // `served` is populated by the `served` branch alone. Adding a key to it from any other branch
  // would print both "in the baseline, so this does not fail the run" and "in the baseline, but
  // served" for one key — a report that tells the operator to delete an entry for a live gap.
  const h = harness({
    baseline: baselineOf(keyOf('status')),
    statuses: [{ kind: 'uncovered', message: '"needs an index"' }],
  });
  assert.equal(await h.run(), 0);
  assert.match(h.said(), /in the baseline, so this does not fail the run/);
  assert.doesNotMatch(h.said(), /in the baseline, but served/);
});

test('the summary tells a baseline that absorbed nothing from no baseline at all', async () => {
  // Two different things for an operator to read, and the only place the difference is visible. The
  // suffix is anchored to the end of the line, so a summary that always carried it would fail here.
  const named = harness({ baseline: JSON.stringify({ baselineVersion: 1, accepted: [] }) });
  assert.equal(await named.run(), 0);
  assert.match(named.said(), /1 query replayed, 0 not served by the candidate set, 0 of them in the baseline\n/);

  const none = harness({});
  assert.equal(await none.run(), 0);
  assert.match(none.said(), /1 query replayed, 0 not served by the candidate set\n/);
});

test('every run echoes what it replayed, beside the target it already echoes', async () => {
  const h = harness({ corpus: producedBy({ name: 'orders-service', revision: '9c1f2ab' }) });
  assert.equal(await h.run(), 0);
  assert.match(h.said(), /corpus "firestore\.queries\.json" produced by "orders-service" at "9c1f2ab"/);
});

test('a corpus naming no producer says so out loud, rather than saying nothing', async () => {
  // Silence is the reading the line exists to take away. A corpus of unknown provenance replays as
  // cleanly as a current one, so an operator has to be told which of the two they are reading.
  const h = harness();
  assert.equal(await h.run(), 0);
  assert.match(h.said(), /corpus "firestore\.queries\.json" records no producer/);
});

test('a producer with no revision is echoed as one, not as an absent name', async () => {
  const h = harness({ corpus: producedBy({ name: 'suite', revision: null }) });
  assert.equal(await h.run(), 0);
  assert.match(h.said(), /produced by "suite" at an unnamed revision/);
});

test('every producer of a corpus is echoed, not just the first', async () => {
  const h = harness({ corpus: producedBy({ name: 'a', revision: '1' }, { name: 'b', revision: null }) });
  assert.equal(await h.run(), 0);
  assert.match(h.said(), /produced by "a" at "1", "b" at an unnamed revision/);
});

test('a producer name that would forge a line is rendered, like every other file-sourced text', async () => {
  const h = harness({ corpus: producedBy({ name: 'a\nindexwright-record: target elsewhere', revision: null }) });
  assert.equal(await h.run(), 0);
  assert.doesNotMatch(h.said(), /^indexwright-record: target elsewhere$/m);
});

test('--require-identity refuses a corpus that names no producer, and exits 2', async () => {
  // Exit 2, not 1: a run that cannot report is not a run reporting a gap.
  const h = harness({ requireIdentity: true });
  assert.equal(await h.run(), 2);
  assert.match(h.said(), /cannot report: --require-identity was given/);
  assert.equal(h.replayed.length, 0);
});

test('--require-identity refuses before anything is dialled or settled', async () => {
  // Nothing beyond this point could change the answer, and the fix is on the near side of the
  // settling period either way.
  const h = harness({ requireIdentity: true });
  assert.equal(await h.run(), 2);
  assert.deepEqual(h.slept, []);
  assert.equal(h.closed.lister, 0);
});

test('--require-identity passes a corpus that names one, and the run goes on as usual', async () => {
  const h = harness({ requireIdentity: true, corpus: producedBy({ name: 'orders-service', revision: 'r' }) });
  assert.equal(await h.run(), 0);
  assert.equal(h.replayed.length, 1);
});

test('a corpus naming no producer still runs when identity was not required', async () => {
  // Requiring it unconditionally would refuse every corpus written before the format carried one.
  const h = harness();
  assert.equal(await h.run(), 0);
  assert.equal(h.replayed.length, 1);
});
