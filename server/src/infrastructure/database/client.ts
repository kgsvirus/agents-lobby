// SQLite database client: better-sqlite3 + Drizzle over it, plus the drizzle
// migration runner. The event bus only needs the raw better-sqlite3 handle,
// so the two stay independently usable.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type LobbyDb = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  readonly sqlite: Database.Database;
  readonly db: LobbyDb;
}

export function openDatabase(file: string): DbHandle {
  const sqlite = new Database(file);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

export function runMigrations(db: LobbyDb, folder: string): void {
  migrate(db, { migrationsFolder: folder });
}

/**
 * Path of the checked-in drizzle migration files.
 *
 * shortcut: resolved from the package root via import.meta.url walk-up so the
 * same code works when run from src (tsx) or dist (tsc build); src ships with
 * the repo, so this holds for any repo-based deployment. If the server is ever
 * shipped without src/, copy the migrations folder into dist at build time.
 */
export function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Package root not found (no package.json above database client)');
    dir = parent;
  }
  return join(dir, 'src', 'infrastructure', 'database', 'migrations');
}
