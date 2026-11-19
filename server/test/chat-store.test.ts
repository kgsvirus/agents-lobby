// Chat message repository — behavior pins on the NEW implementation only.
// The legacy-vs-new equivalence cases (which imported the retired store.mjs)
// were removed with the legacy retirement (809440a on main); the portable
// cases below keep asserting the repository semantics directly: wire shape,
// view forms, pagination + boundary cursors, unread/markSeen bookkeeping,
// project views with an explicit agents list, and lastActivity.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, migrationsFolder } from '../src/infrastructure/database/client.js';
import { ChatMessageRepository } from '../src/modules/chat/infrastructure/message-repository.js';
import { tempDir } from './helpers.js';

type QueryParams = Parameters<ChatMessageRepository['query']>[0];

/** Store-level defaults (the HTTP layer's `0 → 10` arithmetic is the route's). */
const query = (over: Partial<QueryParams>): QueryParams => ({
  view: 'all',
  after: 0,
  before: 0,
  limit: 500,
  agents: [],
  ...over,
});

function openRepo(name: string): { repo: ChatMessageRepository; close(): void } {
  const { db, sqlite } = openDatabase(join(tempDir(), name));
  runMigrations(db, migrationsFolder()); // fresh migrated db, no legacy schema involved
  return { repo: new ChatMessageRepository(sqlite), close: () => void sqlite.close() };
}

describe('chat message repository (new implementation only)', () => {
  it('an EMPTY database: views, boundary cursors, unread and lastActivity are all empty', () => {
    const { repo, close } = openRepo('empty.db');
    try {
      for (const params of [
        query({}),
        query({ view: 'boss' }),
        query({ view: 'agent:ruben' }),
        query({ after: 1 }), // at the first row (none exist)
        query({ after: 100 }), // beyond both ends
        query({ before: 1 }), // exclusive → empty
        query({ before: 100 }),
        query({ limit: 3 }),
      ]) {
        const page = repo.query(params);
        expect(page.rows, JSON.stringify(params)).toEqual([]);
        expect(page.hasMore, JSON.stringify(params)).toBe(false);
      }
      expect(repo.unread('boss')).toEqual([]); // no bookmark, no rows
      expect(repo.lastActivity(['ruben', 'greg'])).toEqual({
        all: null,
        boss: null,
        'agent:ruben': null,
        'agent:greg': null,
      });
    } finally {
      close();
    }
  });

  it('wire shape, unread/markSeen bookkeeping and boundary cursors over a seeded fixture', () => {
    const { repo, close } = openRepo('fixture.db');
    try {
      repo.insert({ ts: '2026-11-14T10:00:00.000Z', from: 'boss', to: 'immigapp', body: 'wake up', sessionId: null });
      repo.insert({ ts: '2026-11-14T10:01:00.000Z', from: 'ruben', to: 'boss', body: 'ack', sessionId: null });
      repo.insert({ ts: '2026-11-14T10:02:00.000Z', from: 'human', to: 'taskflow, ruben', body: 'line one\nline two', sessionId: null });
      repo.insert({ ts: '2026-11-14T10:03:00.000Z', from: 'marvin', to: 'all', body: 'broadcast', sessionId: null });
      repo.insert({ ts: '2026-11-14T10:04:00.000Z', from: 'human', to: null, body: 'webhook row', sessionId: null });
      repo.markSeen('boss', 2);

      // Wire shape round-trip: {id, time, from, to, text}, null receiver,
      // two-line body.
      const all = repo.query(query({}));
      expect(all.rows[4]).toEqual({ id: 5, time: '2026-11-14T10:04:00.000Z', from: 'human', to: null, text: 'webhook row' });
      expect(all.rows[2]?.text).toBe('line one\nline two');

      // unread honors the SAME bookmarks table: through id 2 → rows 3-5.
      expect(repo.unread('boss').map((r) => r.id)).toEqual([3, 4, 5]);

      // markSeen: through id 4 → only row 5 stays unread.
      repo.markSeen('boss', 4);
      expect(repo.unread('boss').map((r) => r.id)).toEqual([5]);

      // lastActivity: per-view latest stamps over the seeded rows. Note the
      // 'all' broadcast (row 4) counts as activity for EVERY agent.
      expect(repo.lastActivity(['ruben', 'greg'])).toEqual({
        all: '2026-11-14T10:04:00.000Z',
        boss: '2026-11-14T10:01:00.000Z', // row 2 (ruben → boss) beats row 1 (boss → immigapp)
        'agent:ruben': '2026-11-14T10:03:00.000Z', // receiver 'all' (row 4) beats ruben's comma-list row 3
        'agent:greg': '2026-11-14T10:03:00.000Z', // receiver 'all' (row 4) beats greg's sender row 2
      });

      // Paging-boundary cursors (rows are ids 1..5): at the first row, at the
      // last row, and beyond both ends.
      expect(repo.query(query({ after: 1 })).rows.map((r) => r.id)).toEqual([2, 3, 4, 5]);
      expect(repo.query(query({ after: 5 })).rows.map((r) => r.id)).toEqual([]);
      expect(repo.query(query({ after: 99 })).rows).toEqual([]);
      expect(repo.query(query({ before: 1 })).rows).toEqual([]); // exclusive → empty
      expect(repo.query(query({ before: 5 })).rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
      expect(repo.query(query({ before: 99 })).rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);

      // hasMore = an extra row exists in the fetch direction (limit+1 probe).
      expect(repo.query(query({ after: 2, limit: 1 }))).toEqual({
        rows: [{ id: 3, time: '2026-11-14T10:02:00.000Z', from: 'human', to: 'taskflow, ruben', text: 'line one\nline two' }],
        hasMore: true,
      });
      expect(repo.query(query({ before: 3, limit: 2 })).rows.map((r) => r.id)).toEqual([1, 2]);
      expect(repo.query(query({ before: 3, limit: 2 })).hasMore).toBe(false);
    } finally {
      close();
    }
  });

  it('project views: an explicit agents list ORs the members; an empty list falls back to the view name', () => {
    const { repo, close } = openRepo('fixture2.db');
    try {
      // Discriminating fixture: each row is reachable via EXACTLY ONE member,
      // plus an unrelated row that must be excluded everywhere.
      repo.insert({ ts: '2026-11-14T10:00:00.000Z', from: 'ruben', to: 'boss', body: 'a', sessionId: null }); // ruben-only (sender)
      repo.insert({ ts: '2026-11-14T10:01:00.000Z', from: 'greg', to: 'taskflow, greg', body: 'b', sessionId: null }); // greg-only (sender + comma-list; NOT ruben)
      repo.insert({ ts: '2026-11-14T10:02:00.000Z', from: 'marvin', to: 'immigapp', body: 'c', sessionId: null }); // unrelated — must be excluded

      // project:TaskFlow with the registry members [ruben, greg]: the UNION —
      // row 1 only via ruben, row 2 only via greg, row 3 excluded. Exact set:
      // a first-member-only query returns [1]; a return-everything bug adds 3.
      expect(repo.query(query({ view: 'project:TaskFlow', agents: ['ruben', 'greg'] })).rows).toEqual([
        { id: 1, time: '2026-11-14T10:00:00.000Z', from: 'ruben', to: 'boss', text: 'a' },
        { id: 2, time: '2026-11-14T10:01:00.000Z', from: 'greg', to: 'taskflow, greg', text: 'b' },
      ]);

      // Single-member lists isolate each member's contribution.
      expect(repo.query(query({ view: 'project:TaskFlow', agents: ['ruben'] })).rows.map((r) => r.id)).toEqual([1]);
      expect(repo.query(query({ view: 'project:TaskFlow', agents: ['greg'] })).rows.map((r) => r.id)).toEqual([2]);

      // Empty agents list → the fallback member is the view name itself, and
      // ONLY the matching rows return (exact sets; a return-everything bug
      // would pull in the other rows and the unrelated row 3).
      expect(repo.query(query({ view: 'project:ruben', agents: [] })).rows.map((r) => r.id)).toEqual([1]);
      expect(repo.query(query({ view: 'project:greg', agents: [] })).rows.map((r) => r.id)).toEqual([2]);
    } finally {
      close();
    }
  });

  it('peer messaging columns: idempotency key, capture suppression, delivery state', () => {
    const { repo, close } = openRepo('peer-columns.db');
    try {
      const first = repo.insert({
        ts: '2026-11-19T10:00:00.000Z',
        from: 'ruben',
        to: 'greg',
        body: 'hello',
        sessionId: 'ses_ruben',
        messageId: 'msg_a',
        captureSuppressed: true,
        deliveryState: 0,
      });
      expect(first.inserted).toBe(true);
      expect(repo.findOwnMessage('msg_a', 'ruben')?.message.id).toBe(first.row.id);
      expect(repo.findOwnMessage('msg_a', 'ruben')?.deliveryState).toBe(0);
      expect(repo.findOwnMessage('msg_a', 'somebody-else')).toBeNull(); // sender-scoped

      // The unique index is the idempotency guarantee: a second row with the
      // same key cannot exist.
      expect(() =>
        repo.insert({
          ts: '2026-11-19T10:00:01.000Z',
          from: 'ruben',
          to: 'greg',
          body: 'hello again',
          sessionId: 'ses_ruben',
          messageId: 'msg_a',
        }),
      ).toThrow();

      // Capture suppression is keyed by the SENDER session.
      expect(repo.isCaptureSuppressed('ses_ruben')).toBe(true);
      expect(repo.isCaptureSuppressed('ses_greg')).toBe(false);
      repo.clearCaptureSuppressed('ses_ruben');
      expect(repo.isCaptureSuppressed('ses_ruben')).toBe(false);

      // Delivery state: peer rows start pending, legacy rows count as sent.
      const legacy = repo.insert({ ts: '2026-11-19T10:02:00.000Z', from: 'boss', to: 'ruben', body: 'x', sessionId: null });
      expect(repo.unconfirmedPeerDeliveries().map((r) => r.id)).toEqual([first.row.id]);
      repo.markDeliverySent(first.row.id);
      expect(repo.unconfirmedPeerDeliveries()).toEqual([]);
      expect(legacy.inserted).toBe(true);
      expect(repo.unconfirmedPeerDeliveries()).toEqual([]);

      const second = repo.insert({
        ts: '2026-11-19T10:03:00.000Z',
        from: 'ruben',
        to: 'human',
        body: 'status',
        sessionId: 'ses_ruben',
        messageId: 'msg_b',
      });
      repo.markDeliveryRetried(second.row.id);
      expect(repo.unconfirmedPeerDeliveries()).toEqual([]);
      expect(legacy.inserted).toBe(true);
    } finally {
      close();
    }
  });
});
