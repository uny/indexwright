import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
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

const ONE_QUERY = corpusOf({ op: 'AND', filters: [equals('status')] });

/**
 * The verb with every seam filled, and a clock that does not tick unless the verb sleeps.
 *
 * The settling period is a minute by design, so a test that waited it out could not pin the gate at
 * all. Here `sleep` *is* the clock: time passes only where the verb asked it to, which also makes
 * every wait the verb takes visible to the test rather than merely slow.
 */
function harness({ listings = [READY], statuses = [], corpus = ONE_QUERY, declared = DECLARED, ...rest } = {}) {
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
    run: () => check(COMMAND, streams, options),
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
  for (const state of ['NEEDS_REPAIR', 'DEFRAGMENTING']) {
    const stuck = harness({ listings: [[{ ...READY[0], state }]] });
    assert.equal(await stuck.run(), 2);
    assert.match(stuck.said(), /readiness could not be established/);
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
  const clean = harness();
  assert.equal(await clean.run(), 0);
  assert.deepEqual(clean.closed, { lister: 1, replayer: 1 });

  const stopped = harness({ statuses: [{ kind: 'failed', message: '"gone"' }] });
  assert.equal(await stopped.run(), 2);
  assert.deepEqual(stopped.closed, { lister: 1, replayer: 1 });

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

  const declining = harness({
    listings: [[{ ...READY[0], state: 'NEEDS_REPAIR' }]],
    lister: async () => ({
      listIndexesAsync: () => (async function* () {
        yield { ...READY[0], state: 'NEEDS_REPAIR' };
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

test('the lister is closed before the replay client is built, so one channel is open at a time', async () => {
  const order = [];
  const h = harness({
    lister: async () => ({
      listIndexesAsync() {
        return (async function* () {
          for (const index of READY) yield index;
        })();
      },
      close: async () => order.push('lister closed'),
    }),
    replayer: async () => {
      order.push('replayer built');
      return { run: async () => ({ kind: 'served' }), close: async () => order.push('replayer closed') };
    },
  });
  assert.equal(await h.run(), 0);
  assert.deepEqual(order, ['lister closed', 'replayer built', 'replayer closed']);
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
