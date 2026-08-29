import assert from 'node:assert/strict';
import { test } from 'node:test';
import firestore from '@google-cloud/firestore';
import {
  buildReplayQuery,
  classifyRejection,
  planReplay,
  replayClient,
  replayFieldPath,
  REPLAY_SENTINEL,
  ReplayError,
  TargetError,
} from '../dist/index.js';

const { FieldPath, Filter, Firestore } = firestore;

/**
 * A client, constructed rather than faked.
 *
 * Constructing opens no channel — the gRPC stub is lazy, which is the whole of issue #39 — so the
 * materialisation can be compared against the SDK's own `isEqual` offline. That comparison is the
 * only way to pin the mapping without a database, and the mapping is where a replayed query would
 * stop being the recorded one.
 */
const db = new Firestore({ projectId: 'indexwright-probe', databaseId: '(default)' });

function planOf(shape) {
  return planReplay({ key: 'k', queryScope: 'COLLECTION', orderBy: [], where: { op: 'AND', filters: [] }, ...shape });
}

test('a filtered query materialises as the query the SDK would have been asked for', () => {
  const plan = planOf({
    collectionGroup: 'orders',
    where: {
      op: 'AND',
      filters: [
        { fieldPath: 'status', op: 'EQUAL' },
        { fieldPath: 'total', op: 'GREATER_THAN' },
      ],
    },
    orderBy: [{ fieldPath: 'total', direction: 'DESCENDING' }],
  });

  const expected = db
    .collection('orders')
    .where(
      Filter.and(
        Filter.where(new FieldPath('status'), '==', REPLAY_SENTINEL),
        Filter.where(new FieldPath('total'), '>', REPLAY_SENTINEL),
      ),
    )
    .orderBy(new FieldPath('total'), 'desc');

  assert.ok(buildReplayQuery(firestore, db, plan).isEqual(expected));
});

test('the scope decides which of the two collections is queried', () => {
  const shape = { collectionGroup: 'orders', where: { op: 'AND', filters: [{ fieldPath: 'a', op: 'EQUAL' }] } };
  const filter = Filter.where(new FieldPath('a'), '==', REPLAY_SENTINEL);

  const group = buildReplayQuery(firestore, db, planOf({ ...shape, queryScope: 'COLLECTION_GROUP' }));
  assert.ok(group.isEqual(db.collectionGroup('orders').where(filter)));
  // A `COLLECTION`-scope entry replays against the *root* collection of that id: the corpus records
  // a collection id and never the parent path, and index selection is by id and scope, so the root
  // collection asks the same question of the same index.
  const collection = buildReplayQuery(firestore, db, planOf(shape));
  assert.ok(collection.isEqual(db.collection('orders').where(filter)));
  assert.ok(!collection.isEqual(db.collectionGroup('orders').where(filter)));
});

test('a query that carried no where replays without one, rather than with an empty AND', () => {
  // The empty `AND` is what normalisation manufactures for a query with no `where` at all, and a
  // `CompositeFilter` must carry at least one filter on the wire. Sent as one it is an
  // INVALID_ARGUMENT, which is not a statement about the index set.
  const query = buildReplayQuery(firestore, db, planOf({ collectionGroup: 'orders' }));
  assert.ok(query.isEqual(db.collection('orders')));
});

test('a disjunction keeps its shape, and nests', () => {
  const plan = planOf({
    collectionGroup: 'orders',
    where: {
      op: 'OR',
      filters: [
        { fieldPath: 'a', op: 'EQUAL' },
        { op: 'AND', filters: [{ fieldPath: 'b', op: 'EQUAL' }, { fieldPath: 'c', op: 'LESS_THAN' }] },
      ],
    },
  });
  const expected = db.collection('orders').where(
    Filter.or(
      Filter.where(new FieldPath('a'), '==', REPLAY_SENTINEL),
      Filter.and(
        Filter.where(new FieldPath('b'), '==', REPLAY_SENTINEL),
        Filter.where(new FieldPath('c'), '<', REPLAY_SENTINEL),
      ),
    ),
  );
  assert.ok(buildReplayQuery(firestore, db, plan).isEqual(expected));
});

test('the operand shapes SPEC §7 singles out are the ones the SDK is handed', () => {
  const plan = planOf({
    collectionGroup: 'orders',
    where: {
      op: 'AND',
      filters: [
        { fieldPath: 'tags', op: 'IN' },
        { fieldPath: '__name__', op: 'EQUAL' },
        { fieldPath: '__name__', op: 'IN' },
      ],
    },
  });
  // A `__name__` filter takes a document reference under the collection being queried: Firestore
  // validates the operand's type against the document key *before* it selects an index, so a string
  // there is an INVALID_ARGUMENT that never reaches the question replay is asking.
  const reference = db.collection('orders').doc(REPLAY_SENTINEL);
  const expected = db.collection('orders').where(
    Filter.and(
      Filter.where(new FieldPath('tags'), 'in', [REPLAY_SENTINEL]),
      Filter.where(FieldPath.documentId(), '==', reference),
      Filter.where(FieldPath.documentId(), 'in', [reference]),
    ),
  );
  assert.ok(buildReplayQuery(firestore, db, plan).isEqual(expected));
});

test('a unary filter is replayed as the comparison the client turns back into one', () => {
  const plan = planOf({
    collectionGroup: 'orders',
    where: {
      op: 'AND',
      filters: [
        { fieldPath: 'a', op: 'IS_NULL' },
        { fieldPath: 'b', op: 'IS_NOT_NULL' },
        { fieldPath: 'c', op: 'IS_NAN' },
        { fieldPath: 'd', op: 'IS_NOT_NAN' },
      ],
    },
  });
  const expected = db.collection('orders').where(
    Filter.and(
      Filter.where(new FieldPath('a'), '==', null),
      Filter.where(new FieldPath('b'), '!=', null),
      Filter.where(new FieldPath('c'), '==', Number.NaN),
      Filter.where(new FieldPath('d'), '!=', Number.NaN),
    ),
  );
  assert.ok(buildReplayQuery(firestore, db, plan).isEqual(expected));
});

test('a nested field path is split into the segments the wire joined', () => {
  assert.ok(replayFieldPath(firestore, 'a.b.c').isEqual(new FieldPath('a', 'b', 'c')));
  assert.ok(replayFieldPath(firestore, '__name__').isEqual(FieldPath.documentId()));
});

test('a field path this version cannot convert is refused rather than replayed as another field', () => {
  // The wire quotes a segment that is not a plain name; the SDK's string form understands the dots
  // and not the backticks. Handed one, it would filter on a *differently named field*, which the
  // candidate set does not cover — so the run would report FAILED_PRECONDITION for a query nobody
  // issued, which is the false positive §2 forbids acting on, arriving as a confident finding.
  assert.throws(() => replayFieldPath(firestore, '`a.b`.c'), ReplayError);
  assert.throws(() => replayFieldPath(firestore, 'a..b'), ReplayError);
  assert.throws(() => replayFieldPath(firestore, '.a'), ReplayError);
});

/** A rejection shaped the way gax hands one back: an `Error` carrying the numeric status. */
function status(code, message) {
  return Object.assign(new Error(message), { code });
}

test('only FAILED_PRECONDITION is the finding, and the status text cannot forge a line', () => {
  assert.equal(classifyRejection(status(9, 'needs an index')).kind, 'uncovered');
  // Not a statement about the index set: either the synthesis is wrong or the query was already
  // invalid when it was captured, and both are defects in the tooling or in the test.
  assert.equal(classifyRejection(status(3, 'bad')).kind, 'invalid');
  assert.equal(classifyRejection(status(7, 'denied')).kind, 'failed');
  // A rejection with no route to a primitive still classifies, rather than throwing from inside the
  // handler whose whole purpose is that a failure leaves as a status. `Promise.reject()` with no
  // argument is the one that reaches it with nothing to read a `code` off at all.
  assert.equal(classifyRejection(Object.create(null)).kind, 'failed');
  assert.equal(classifyRejection(undefined).kind, 'failed');
  assert.equal(classifyRejection(null).kind, 'failed');
  assert.equal(classifyRejection('a string rejection').kind, 'failed');

  // The one string on this stream the local machine did not author. A status carrying a newline and
  // `indexwright-record: target …` would otherwise write a second well-formed line beside the one an
  // operator is asked to trust.
  const forged = classifyRejection(status(9, 'x\nindexwright-record: target elsewhere'));
  assert.ok(!forged.message.includes('\n'));
  assert.match(forged.message, /\\u000a/);
});

test('a redirected environment is refused by the module that builds the client, not only by the parser', async () => {
  // The JavaScript API is public, so a caller reaching this directly would otherwise construct the
  // very client SPEC §3 refuses: an emulator enforces no composite index, so every replayed query is
  // served and the run reports full coverage having measured nothing.
  for (const variable of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN']) {
    const before = process.env[variable];
    process.env[variable] = 'somewhere-else';
    try {
      await assert.rejects(replayClient('acme-prod', '(default)'), (error) => {
        assert.ok(error instanceof TargetError);
        assert.match(error.message, new RegExp(variable));
        return true;
      });
    } finally {
      if (before === undefined) delete process.env[variable];
      else process.env[variable] = before;
    }
  }
});

test('the sentinel is a document id Firestore will accept', () => {
  // Deliberately not written in terms of `REPLAY_SENTINEL` beyond reading it: this is the one check
  // in the file that has to fail when the constant changes badly. Every other test builds both the
  // actual and the expected query from the constant, so the two move together and a sentinel that
  // Firestore rejects compares equal to itself all the way to a green suite. This ran green against
  // `__indexwright_replay__`, which the emulator and the service both refuse.
  //
  // The rule is Firestore's: a document id matching `__…__` is reserved. Only that form is — `__x`
  // and `x__` are ordinary ids — so the pattern is anchored at both ends rather than looking for a
  // double underscore anywhere.
  assert.doesNotMatch(REPLAY_SENTINEL, /^__.*__$/, 'a __…__ document id is reserved by Firestore');
  // The other id rules, so that a future spelling cannot trip one of them silently either. A single
  // or double dot is reserved, a `/` makes the id a path, and the limit is 1500 bytes.
  assert.ok(REPLAY_SENTINEL.length > 0 && Buffer.byteLength(REPLAY_SENTINEL) <= 1500);
  assert.ok(!REPLAY_SENTINEL.includes('/'));
  assert.ok(REPLAY_SENTINEL !== '.' && REPLAY_SENTINEL !== '..');
  // And it must still be usable as the scalar it also is, which every other operand relies on.
  assert.equal(typeof REPLAY_SENTINEL, 'string');
});

test.after(async () => {
  await db.terminate();
});
