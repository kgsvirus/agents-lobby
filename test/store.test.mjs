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
    assert.deepEqual(store.query({ view: 'all' }).rows, []);
    assert.equal(store.query({ view: 'all' }).hasMore, false);
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
    assert.deepEqual(all.rows.map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(
      all.rows.map((r) => [r.time, r.from, r.to, r.text]),
      [
        ['2026-11-14T10:00:00.000Z', 'boss', 'immigapp', 'wake up'],
        ['2026-11-14T10:01:00.000Z', 'ruben', 'boss', 'ack'],
        ['2026-11-14T10:02:00.000Z', 'human', 'taskflow, ruben', 'line one\nline two'],
      ],
    );

    // two-line body round-trips byte-identical
    assert.equal(all.rows[2].text, 'line one\nline two');

    // boss view: from === 'boss' OR to === 'boss'
    assert.deepEqual(store.query({ view: 'boss' }).rows.map((r) => r.id), [1, 2]);

    // agent:ruben: sender is ruben OR to is 'all' / list containing ruben
    assert.deepEqual(store.query({ view: 'agent:ruben' }).rows.map((r) => r.id), [2, 3]);

    // project:TaskFlow: any of the project's agents involved — same set as agent:ruben
    const project = store.query({ view: 'project:TaskFlow', agents: ['taskflow', 'ruben'] });
    assert.deepEqual(project.rows, store.query({ view: 'agent:ruben' }).rows);

    // after: 2 → only id 3
    assert.deepEqual(store.query({ after: 2 }).rows.map((r) => r.id), [3]);

    // after: 0, limit: 2 → latest 2 rows, ascending
    assert.deepEqual(store.query({ after: 0, limit: 2 }).rows.map((r) => r.id), [2, 3]);

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
    store.insert({ ts: '2026-11-14T10:00:00.000Z', from: 'ruben', to: 'boss', body: 'a' });
    const b = store.insert({ ts: '2026-11-14T10:01:00.000Z', from: 'ruben', to: 'boss', body: 'b' });
    store.insert({ ts: '2026-11-14T10:02:00.000Z', from: 'ruben', to: 'boss', body: 'c' });

    // through the snapshot's last id: rows inserted after stay unread
    store.markSeen('boss', b.id);
    const unread = store.unread('boss');
    assert.deepEqual(unread.map((r) => r.text), ['c']);

    // no-arg markSeen jumps to MAX(id)
    store.markSeen('boss');
    assert.deepEqual(store.unread('boss'), []);
  } finally {
    store.close();
  }
});

test('before-pagination, hasMore, and onInsert notifications', () => {
  const store = openStore(tmpDb('paginate'));
  try {
    for (let i = 1; i <= 12; i++)
      store.insert({ ts: `2026-11-17T10:${String(i).padStart(2, '0')}:00.000Z`, from: 'boss', to: 'human', body: `m${i}` });

    // initial page: latest 10 ascending, hasMore = older exist
    const page1 = store.query({ after: 0, limit: 10 });
    assert.deepEqual(page1.rows.map((r) => r.id), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(page1.hasMore, true);

    // older page via before=3: the two remaining, hasMore now false
    const page2 = store.query({ before: 3, limit: 10 });
    assert.deepEqual(page2.rows.map((r) => r.id), [1, 2]);
    assert.equal(page2.hasMore, false);

    // before respects view filters
    const boss = store.query({ view: 'boss', before: 13, limit: 5 });
    assert.deepEqual(boss.rows.map((r) => r.id), [8, 9, 10, 11, 12]);
    assert.equal(boss.hasMore, true);

    // catch-up direction: hasMore reflects more rows in fetch direction
    // (12 total, limit 2 fetched both newer rows → nothing further)
    const up = store.query({ after: 10, limit: 2 });
    assert.deepEqual(up.rows.map((r) => r.id), [11, 12]);
    assert.equal(up.hasMore, false);

    // SSE source: insert fires onInsert with the full row
    const seen = [];
    const off = store.onInsert((row) => seen.push(row));
    const ins = store.insert({ ts: '2026-11-17T11:00:00.000Z', from: 'human', to: 'boss', body: 'live' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, ins.id);
    assert.equal(seen[0].text, 'live');
    off();
    store.insert({ ts: '2026-11-17T11:01:00.000Z', from: 'human', to: 'boss', body: 'after-off' });
    assert.equal(seen.length, 1); // unsubscribed
  } finally {
    store.close();
  }
});

test('lastActivity: per-view latest ts, empty table → null', () => {
  const store = openStore(tmpDb('lastact'));
  try {
    assert.deepEqual(store.lastActivity(['ruben', 'greg']), {
      all: null,
      boss: null,
      'agent:ruben': null,
      'agent:greg': null,
    });

    store.insert({ ts: '2026-11-14T10:00:00.000Z', from: 'boss', to: 'immigapp', body: 'wake up' });
    store.insert({ ts: '2026-11-14T10:01:00.000Z', from: 'ruben', to: 'boss', body: 'ack' });
    store.insert({ ts: '2026-11-14T10:02:00.000Z', from: 'human', to: 'taskflow, ruben', body: 'hi' });
    // ts is assigned at insert, so id order == ts order (the invariant
    // lastActivity's top-1 lookups rely on) — greg's row is the newest.
    store.insert({ ts: '2026-11-14T10:03:00.000Z', from: 'greg', to: 'human', body: 'greg reply' });

    const la = store.lastActivity(['ruben', 'greg']);
    assert.equal(la.all, '2026-11-14T10:03:00.000Z');
    assert.equal(la.boss, '2026-11-14T10:01:00.000Z'); // latest of boss-view rows (id1, id2)
    assert.equal(la['agent:ruben'], '2026-11-14T10:02:00.000Z'); // receiver list includes ruben
    assert.equal(la['agent:greg'], '2026-11-14T10:03:00.000Z'); // has history, not blank
  } finally {
    store.close();
  }
});
