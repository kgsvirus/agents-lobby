// Baseline migration verification (decision 6): apply the drizzle baseline to
// a fresh temp db and compare pragma table_info / index_list against the
// LEGACY schema — against the one read-only COPY of the canonical
// .data/messages.db when present, otherwise against a fixture created with
// the store.mjs DDL. Additionally, the baseline is applied to an ISOLATED
// copy of that legacy database to prove it can be migrated in place without
// touching existing tables or data (row counts, MAX(id), wire-alias samples).
// Tolerated delta (documented inline below): notnull on INTEGER PRIMARY KEY
// columns (rowid alias — cannot be null under either declaration); the fresh
// db additionally contains the `events` table.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationsFolder, openDatabase, runMigrations } from '../src/infrastructure/database/client.js';
import { tempDir } from './helpers.js';

const require = createRequire(import.meta.url);
// Legacy store imported (not paraphrased) so the fixture DDL can never drift.
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const { openStore } = require('../../store.mjs') as {
  openStore: (file?: string) => {
    insert: (row: { ts: string; from: string; to: string | null; body: string; sessionId?: string | null }) => unknown;
    close: () => void;
  };
};

/** server/.data/verify-copy.db — the single read-only copy of the canonical db (decision 6). */
const canonicalCopyPath = join(
  dirname(fileURLToPath(import.meta.url)), // server/test/
  '..',
  '.data',
  'verify-copy.db',
);

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as ColumnInfo[];
}

function explicitIndexes(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all() as Array<{ name: string; origin: string }>)
    .filter((row) => row.origin === 'c')
    .map((row) => row.name);
}

/** Compare every legacy table/column/index against the migrated fresh db. */
function expectSchemaMatch(legacy: Database.Database, fresh: Database.Database): void {
  const legacyTables = tables(legacy);
  const freshTables = tables(fresh);
  for (const table of legacyTables) {
    expect(freshTables).toContain(table);

    const legacyCols = columns(legacy, table);
    const freshCols = columns(fresh, table);
    expect(freshCols.map((c) => c.name)).toEqual(legacyCols.map((c) => c.name)); // same order
    for (const legacyCol of legacyCols) {
      const freshCol = freshCols.find((c) => c.name === legacyCol.name);
      if (freshCol === undefined) throw new Error(`column ${table}.${legacyCol.name} missing in migrated schema`);
      expect(freshCol.type).toBe(legacyCol.type);
      expect(freshCol.dflt_value).toBe(legacyCol.dflt_value);
      // Nullability: compared exactly, EXCEPT for INTEGER PRIMARY KEY columns
      // (the rowid alias). SQLite treats an INTEGER PRIMARY KEY as the rowid —
      // it can never be null regardless of the declaration — and drizzle
      // emits the explicit NOT NULL form, so notnull differs there with zero
      // behavioral effect. All other columns (including the legacy TEXT PK
      // `bookmarks.consumer`, which SQLite allows NULL in) must match.
      if (!(legacyCol.pk === 1 && legacyCol.type.toUpperCase() === 'INTEGER')) {
        expect(freshCol.notnull).toBe(legacyCol.notnull);
      }
    }

    const legacyIndexes = explicitIndexes(legacy, table);
    const freshIndexes = explicitIndexes(fresh, table);
    for (const index of legacyIndexes) expect(freshIndexes).toContain(index);
  }
}

interface WireRow {
  id: number;
  time: string;
  from: string;
  to: string | null;
  text: string;
}

interface DataSnapshot {
  messageCount: number;
  bookmarkCount: number;
  maxMessageId: number | null;
  maxBookmarkLastSeenId: number | null;
  /** First and last 3 message rows in the wire shape (store.mjs:17 alias). */
  samples: WireRow[];
}

function snapshot(db: Database.Database): DataSnapshot {
  const count = (sql: string): number => {
    const row = db.prepare(sql).get() as { n: number } | undefined;
    return row?.n ?? 0;
  };
  const max = (sql: string): number | null => {
    const row = db.prepare(sql).get() as { m: number | null } | undefined;
    return row?.m ?? null;
  };
  const all = db
    .prepare('SELECT id, ts AS time, sender AS "from", receiver AS "to", body AS text FROM messages ORDER BY id')
    .all() as WireRow[];
  return {
    messageCount: count('SELECT COUNT(*) AS n FROM messages'),
    bookmarkCount: count('SELECT COUNT(*) AS n FROM bookmarks'),
    maxMessageId: max('SELECT MAX(id) AS m FROM messages'),
    maxBookmarkLastSeenId: max('SELECT MAX(last_seen_id) AS m FROM bookmarks'),
    samples: [...all.slice(0, 3), ...all.slice(-3)],
  };
}

describe('baseline migration', () => {
  it('applies cleanly to a fresh db and matches the legacy schema', async () => {
    // Fresh migrated db (drizzle-kit baseline).
    const dir = tempDir();
    const fresh = openDatabase(join(dir, 'fresh.db'));
    expect(() => runMigrations(fresh.db, migrationsFolder())).not.toThrow();

    // Canonical copy when available; store.mjs DDL fixture otherwise.
    let legacy: Database.Database;
    let source: string;
    if (existsSync(canonicalCopyPath)) {
      legacy = new Database(canonicalCopyPath, { readonly: true });
      source = `canonical copy (${canonicalCopyPath})`;
    } else {
      console.warn('[migration-test] canonical copy unavailable; verifying against store.mjs DDL fixture');
      const fixturePath = join(dir, 'legacy-fixture.db');
      const store = openStore(fixturePath);
      store.insert({ ts: '2026-11-17T00:00:00Z', from: 'human', to: 'boss', body: 'fixture' });
      store.close();
      legacy = new Database(fixturePath, { readonly: true });
      source = `store.mjs fixture (${fixturePath})`;
    }
    console.log(`[migration-test] schema comparison source: ${source}`);

    try {
      expectSchemaMatch(legacy, fresh.sqlite);
    } finally {
      legacy.close();
    }
  });

  it('the fresh schema additionally contains the shared events cursor table', async () => {
    const dir = tempDir();
    const fresh = openDatabase(join(dir, 'fresh.db'));
    runMigrations(fresh.db, migrationsFolder());
    const cols = columns(fresh.sqlite, 'events').map((c) => c.name);
    expect(tables(fresh.sqlite)).toContain('events');
    expect(cols).toEqual(['id', 'type', 'payload', 'ts']);
    await fresh.sqlite.close();
  });

  it('the baseline migrates a populated legacy copy in place: legacy tables untouched, data identical', () => {
    const dir = tempDir();
    // Source: canonical copy when present, otherwise a populated store.mjs fixture.
    let sourcePath: string;
    let source: string;
    if (existsSync(canonicalCopyPath)) {
      sourcePath = canonicalCopyPath;
      source = `canonical copy (${sourcePath})`;
    } else {
      console.warn('[migration-test] canonical copy unavailable; verifying against a populated store.mjs fixture');
      sourcePath = join(dir, 'legacy-fixture.db');
      const store = openStore(sourcePath);
      store.insert({ ts: '2026-11-17T00:00:00Z', from: 'human', to: 'boss', body: 'fixture 1' });
      store.insert({ ts: '2026-11-17T00:00:01Z', from: 'boss', to: 'all', body: 'fixture 2', sessionId: 'ses_x' });
      store.markSeen('boss', 2);
      store.close();
      source = `store.mjs fixture (${sourcePath})`;
    }
    console.log(`[migration-test] in-place migration source: ${source}`);

    const before = new Database(sourcePath, { readonly: true });
    try {
      const beforeData = snapshot(before);

      // Isolated copy: the checked-in canonical copy itself is never mutated.
      const isolatedPath = join(dir, 'isolated.db');
      copyFileSync(sourcePath, isolatedPath);
      const isolated = openDatabase(isolatedPath);
      expect(() => runMigrations(isolated.db, migrationsFolder())).not.toThrow();

      // Data checks: rows, max ids, wire-alias samples all unchanged.
      expect(snapshot(isolated.sqlite)).toEqual(beforeData);

      // Schema checks: legacy tables/columns/indexes exactly as before.
      expectSchemaMatch(before, isolated.sqlite);

      // Baseline recorded + events cursor present. The journal now holds the
      // baseline AND the additive migrations (registry_mirror Phase 4;
      // projects/agents Phase 5; PK-less rowid rebuild Phase 5 fix round).
      expect(tables(isolated.sqlite)).toContain('events');
      expect(tables(isolated.sqlite)).toEqual(expect.arrayContaining(['agents', 'projects']));
      const journal = isolated.sqlite
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '__drizzle_migrations'")
        .get() as { n: number };
      expect(journal.n).toBe(1);
      const applied = isolated.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get();
      expect(applied).toEqual({ n: 4 });
      isolated.sqlite.close();
    } finally {
      before.close();
    }
  });
});
