// Chat store repository equivalence (store.mjs port): for equivalent inputs,
// the repository must return the SAME result shapes as the legacy store.
// Two sources: (1) server/.data/verify-copy.db — a read-only COPY of the
// canonical db (realistic rows; never touched by tests), compared through
// openStore() itself on an isolated copy; (2) a fresh crafted fixture mirroring
// the root test/*.mjs expectations (views, membership forms, pagination,
// unread/bookmark, lastActivity). The canonical db is never written.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, migrationsFolder } from '../src/infrastructure/database/client.js';
import { ChatMessageRepository } from '../src/modules/chat/infrastructure/message-repository.js';
import { tempDir } from './helpers.js';

const require = createRequire(import.meta.url);
// Legacy store imported (not paraphrased) so equivalence is measured against
// the REAL implementation, exactly like migration.test.ts does.
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const { openStore } = require('../../store.mjs') as {
  openStore: (file?: string) => {
    insert: (row: { ts: string; from: string; to: string | null; body: string; sessionId?: string | null }) => { id: number };
    query: (params: Record<string, unknown>) => { rows: unknown[]; hasMore: boolean };
    unread: (consumer?: string) => unknown[];
    markSeen: (consumer?: string, throughId?: number) => void;
    lastActivity: (agents?: string[]) => Record<string, string | null>;
    close: () => void;
  };
};

const canonicalCopyPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.data', 'verify-copy.db');

const QUERY_MATRIX: Array<Record<string, unknown>> = [
  { view: 'all' },
  { view: 'boss' },
  { view: 'agent:ruben' },
  { view: 'agent:greg' },
  { view: 'agent:nobody' },
  { view: 'all', after: 815 },
  { view: 'all', after: 815, limit: 2 },
  { view: 'boss', after: 800, limit: 5 },
  { view: 'all', before: 815 },
  { view: 'all', before: 815, limit: 3 },
  { view: 'boss', before: 815, limit: 5 },
  { view: 'agent:ruben', before: 815, limit: 4 },
  { view: 'all', limit: 0 },
  { view: 'all', limit: 2 },
  { view: 'boss', limit: 500 },
  { view: 'agent:ruben', after: 700, limit: 1000 },
  // Paging-boundary cursors (finding 6): at the first row, at the last row,
  // and beyond both ends (the copy spans ids 1..821 with gaps; real ids).
  { view: 'all', after: 1 },
  { view: 'all', after: 821 },
  { view: 'all', after: 900 },
  { view: 'all', before: 1 },
  { view: 'all', before: 900 },
  { view: 'boss', after: 821 },
  { view: 'boss', before: 1 },
  { view: 'agent:ruben', after: 900 },
];

/** Compare the legacy store and the repository over the SAME db for one query. */
function compareQuery(
  legacy: ReturnType<typeof openStore>,
  repo: { query: (params: Record<string, unknown>) => { rows: unknown[]; hasMore: boolean } },
  params: Record<string, unknown>,
): void {
  const expected = legacy.query(params);
  const actual = repo.query({
    view: String(params.view ?? 'all'),
    after: Number(params.after ?? 0) || 0,
    before: Number(params.before ?? 0) || 0,
    // Store-level semantics: pass the limit through EXACTLY (store.mjs
    // defaults 500; the HTTP layer's `0 → 10` arithmetic is the
    // route's, tested separately).
    limit: params.limit === undefined ? 500 : Number(params.limit),
    agents: (params.agents as string[] | undefined) ?? [],
  });
  expect(actual.rows, JSON.stringify(params)).toEqual(expected.rows);
  expect(actual.hasMore, JSON.stringify(params)).toEqual(expected.hasMore);
}

describe('chat message repository — equivalence with store.mjs', () => {
  it.skipIf(!existsSync(canonicalCopyPath))(
    'matches the legacy store on every query of an isolated copy of the canonical db',
    () => {
      const dir = tempDir();
      const copyPath = join(dir, 'verify-copy.db');
      copyFileSync(canonicalCopyPath, copyPath); // the checked-in copy is never mutated

      const legacy = openStore(copyPath);
      const repo = new ChatMessageRepository(new (require('better-sqlite3') as typeof import('better-sqlite3').default)(copyPath));
      try {
        for (const params of QUERY_MATRIX) {
          compareQuery(legacy, repo, { ...params, agents: [] });
        }

        expect(repo.unread('boss')).toEqual(legacy.unread('boss'));

        // lastActivity over the real agent names present in the copy.
        const agents = ['ruben', 'greg', 'taskflow', 'immigapp', 'marvin', 'porty'];
        expect(repo.lastActivity(agents)).toEqual(legacy.lastActivity(agents));
        expect(repo.lastActivity([])).toEqual(legacy.lastActivity([]));
      } finally {
        legacy.close();
      }
    },
  );

  it('matches the legacy store on an EMPTY database (views, unread, lastActivity, boundary cursors)', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'empty.db');
    const legacy = openStore(dbPath); // creates the legacy schema
    const repo = new ChatMessageRepository(new (require('better-sqlite3') as typeof import('better-sqlite3').default)(dbPath));
    try {
      for (const params of [
        { view: 'all' },
        { view: 'boss' },
        { view: 'agent:ruben' },
        { after: 1 },
        { after: 100 },
        { before: 1 },
        { before: 100 },
        { limit: 3 },
      ]) {
        compareQuery(legacy, repo, params);
      }
      expect(repo.unread('boss')).toEqual(legacy.unread('boss'));
      expect(repo.lastActivity(['ruben', 'greg'])).toEqual(legacy.lastActivity(['ruben', 'greg']));
    } finally {
      legacy.close();
    }
  });

  it('matches the legacy store on a fresh fixture mirroring the root store tests', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'fixture.db');
    const legacy = openStore(dbPath);
    legacy.insert({ ts: '2026-11-14T10:00:00.000Z', from: 'boss', to: 'immigapp', body: 'wake up' });
    legacy.insert({ ts: '2026-11-14T10:01:00.000Z', from: 'ruben', to: 'boss', body: 'ack' });
    legacy.insert({ ts: '2026-11-14T10:02:00.000Z', from: 'human', to: 'taskflow, ruben', body: 'line one\nline two' });
    legacy.insert({ ts: '2026-11-14T10:03:00.000Z', from: 'marvin', to: 'all', body: 'broadcast' });
    legacy.insert({ ts: '2026-11-14T10:04:00.000Z', from: 'human', to: null, body: 'webhook row' });
    legacy.markSeen('boss', 2);

    const { db, sqlite } = openDatabase(dbPath); // the SAME file: identical rows for both implementations
    runMigrations(db, migrationsFolder()); // baseline is a no-op on the legacy schema (already applied by openStore)
    const repo = new ChatMessageRepository(sqlite);
    try {
      for (const params of [
        { view: 'all' },
        { view: 'boss' },
        { view: 'agent:ruben' },
        { view: 'agent:marvin' },
        { view: 'agent:human' },
        { view: 'project:TaskFlow', agents: ['taskflow', 'ruben'] },
        { view: 'project:Unknown', agents: [] },
        { after: 2 },
        { after: 2, limit: 1 },
        { before: 3 },
        { before: 3, limit: 2 },
        { limit: 2 },
        // Paging-boundary cursors (finding 6): rows are ids 1..5 here.
        { after: 1 }, // at the first row
        { after: 5 }, // at the last row
        { after: 99 }, // beyond the last row
        { before: 1 }, // at the first row (exclusive → empty)
        { before: 5 },
        { before: 99 }, // beyond the last row → all rows
        { view: 'boss', after: 99 },
        { view: 'agent:marvin', before: 99 },
      ]) {
        compareQuery(legacy, repo, params);
      }

      // Wire shape round-trip: {id, time, from, to, text}, null receiver, two-line body.
      const all = repo.query({ view: 'all', after: 0, before: 0, limit: 500, agents: [] });
      expect(all.rows[4]).toEqual({ id: 5, time: '2026-11-14T10:04:00.000Z', from: 'human', to: null, text: 'webhook row' });
      expect(all.rows[2]?.text).toBe('line one\nline two');

      // unread honors the SAME bookmark table (markSeen wrote through the legacy store).
      expect(repo.unread('boss')).toEqual(legacy.unread('boss'));

      // markSeen: repository bookmark writes are visible to the legacy store
      // too — through id 4, only row 5 stays unread.
      repo.markSeen('boss', 4);
      expect(legacy.unread('boss').map((r) => (r as { id: number }).id)).toEqual([5]);

      expect(repo.lastActivity(['ruben', 'greg'])).toEqual(legacy.lastActivity(['ruben', 'greg']));
    } finally {
      legacy.close();
      sqlite.close();
    }
  });

  it('query matches the legacy store with a project view listing agent names', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'fixture2.db');
    const legacy = openStore(dbPath);
    legacy.insert({ ts: '2026-11-14T10:00:00.000Z', from: 'ruben', to: 'boss', body: 'a' });
    legacy.insert({ ts: '2026-11-14T10:01:00.000Z', from: 'greg', to: 'ruben, marvin', body: 'b' });
    const { db, sqlite } = openDatabase(dbPath);
    runMigrations(db, migrationsFolder());
    const repo = new ChatMessageRepository(sqlite);
    try {
      const expected = legacy.query({ view: 'project:TaskFlow', agents: ['ruben', 'greg'] });
      const actual = repo.query({ view: 'project:TaskFlow', after: 0, before: 0, limit: 500, agents: ['ruben', 'greg'] });
      expect(actual.rows).toEqual(expected.rows);
      // Empty agents list → the legacy fallback uses the view name as the member.
      const expected2 = legacy.query({ view: 'project:ruben', agents: [] });
      const actual2 = repo.query({ view: 'project:ruben', after: 0, before: 0, limit: 500, agents: [] });
      expect(actual2.rows).toEqual(expected2.rows);
    } finally {
      legacy.close();
      sqlite.close();
    }
  });
});
