import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let openStore;
try {
  ({ openStore } = await import('../store.mjs'));
} catch (e) {
  // module missing during RED phase — tests below will fail on undefined openStore
  openStore = null;
}

const files = [];
function tmpDb(name) {
  const f = path.join(os.tmpdir(), `msgdb-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  files.push(f);
  return f;
}

after(() => {
  for (const f of files) fs.rmSync(f, { force: true });
});

test('empty db: query and unread return [], markSeen is a no-op', () => {
  const store = openStore(tmpDb('empty'));
  try {
    assert.deepEqual(store.query({ view: 'all' }), []);
    assert.deepEqual(store.unread('boss'), []);
    store.markSeen('boss'); // must not throw
    assert.deepEqual(store.unread('boss'), []);
  } finally {
    store.close();
  }
});

test('insert/query views, pagination, unread/bookmark', () => {
  const store = openStore(tmpDb('main'));
  try {
    const id1 = store.insert({ ts: '2026-11-14T10:00:00.000Z', from: 'boss', to: 'immigapp', body: 'wake up' }).id;
    const id2 = store.insert({ ts: '2026-11-14T10:01:00.000Z', from: 'ruben', to: 'boss', body: 'ack' }).id;
    const id3 = store.insert({ ts: '2026-11-14T10:02:00.000Z', from: 'human', to: 'taskflow, ruben', body: 'line one\nline two' }).id;

    assert.deepEqual([id1, id2, id3], [1, 2, 3]);

    // all: 3 rows ascending, wire shape { id, time, from, to, text }
    const all = store.query({ view: 'all' });
    assert.deepEqual(all.map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(
      all.map((r) => [r.time, r.from, r.to, r.text]),
      [
        ['2026-11-14T10:00:00.000Z', 'boss', 'immigapp', 'wake up'],
        ['2026-11-14T10:01:00.000Z', 'ruben', 'boss', 'ack'],
        ['2026-11-14T10:02:00.000Z', 'human', 'taskflow, ruben', 'line one\nline two'],
      ],
    );

    // two-line body round-trips byte-identical
    assert.equal(all[2].text, 'line one\nline two');

    // boss view: from === 'boss' OR to === 'boss'
    assert.deepEqual(store.query({ view: 'boss' }).map((r) => r.id), [1, 2]);

    // agent:ruben: sender is ruben OR to is 'all' / list containing ruben
    assert.deepEqual(store.query({ view: 'agent:ruben' }).map((r) => r.id), [2, 3]);

    // project:TaskFlow: any of the project's agents involved — same set as agent:ruben
    const project = store.query({ view: 'project:TaskFlow', agents: ['taskflow', 'ruben'] });
    assert.deepEqual(project, store.query({ view: 'agent:ruben' }));

    // after: 2 → only id 3
    assert.deepEqual(store.query({ after: 2 }).map((r) => r.id), [3]);

    // after: 0, limit: 2 → latest 2 rows, ascending
    assert.deepEqual(store.query({ after: 0, limit: 2 }).map((r) => r.id), [2, 3]);

    // unread before any mark → all rows since bookmark (0), ascending
    assert.deepEqual(store.unread('boss').map((r) => r.id), [1, 2, 3]);

    // markSeen advances bookmark to MAX(id); unread is now empty
    store.markSeen('boss');
    assert.deepEqual(store.unread('boss'), []);
  } finally {
    store.close();
  }
});

test('markSeen(throughId) bookmarks the snapshot only — no race swallowing', () => {
  const store = openStore(tmpDb('race'));
  try {
    store.insert({ ts: '2026-11-14T11:00:00.000Z', from: 'human', to: 'boss', body: 'one' });
    store.insert({ ts: '2026-11-14T11:00:01.000Z', from: 'human', to: 'boss', body: 'two' });

    // wakeBoss-style: snapshot the unread slice, THEN a row races in.
    const slice = store.unread('boss');
    assert.deepEqual(slice.map((r) => r.text), ['one', 'two']);
    const snapshotMax = slice[slice.length - 1].id;
    const lateId = store.insert({ ts: '2026-11-14T11:00:02.000Z', from: 'human', to: 'boss', body: 'late' }).id;

    // Bookmark through the captured slice only: the late row must survive.
    store.markSeen('boss', snapshotMax);
    assert.deepEqual(store.unread('boss').map((r) => r.id), [lateId]);

    // no-arg form still bookmarks MAX(id)
    store.markSeen('boss');
    assert.deepEqual(store.unread('boss'), []);
  } finally {
    store.close();
  }
});
