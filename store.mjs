// store.mjs — SQLite message store for the lobby (node:sqlite, zero deps).
// Wire shape per message: { id, time, from, to, text } (ts/sender/receiver/body internal).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  sender TEXT NOT NULL, receiver TEXT, body TEXT NOT NULL, session_id TEXT);
CREATE TABLE IF NOT EXISTS bookmarks (
  consumer TEXT PRIMARY KEY, last_seen_id INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_msg_receiver ON messages(receiver, id);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender, id);
`;

const ROW_COLS = 'id, ts AS time, sender AS "from", receiver AS "to", body AS text';

// D11 membership: receiver = 'all' OR exact OR comma-list containing name (spaces normalized).
const MEMBER_CLAUSE = "(sender = ? OR receiver = 'all' OR receiver = ? OR (',' || REPLACE(receiver, ' ', '') || ',') LIKE '%,' || ? || ',%')";

export function openStore(file = './.data/messages.db') {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    'INSERT INTO messages (ts, sender, receiver, body, session_id) VALUES (?, ?, ?, ?, ?)',
  );
  const maxIdStmt = db.prepare('SELECT MAX(id) AS m FROM messages');
  const bookmarkStmt = db.prepare('SELECT last_seen_id FROM bookmarks WHERE consumer = ?');
  const upsertBookmarkStmt = db.prepare(
    `INSERT INTO bookmarks (consumer, last_seen_id) VALUES (?, ?)
     ON CONFLICT(consumer) DO UPDATE SET last_seen_id = excluded.last_seen_id`,
  );

  function insert({ ts, from, to, body, sessionId = null }) {
    const r = insertStmt.run(ts, from, to, body, sessionId);
    return { id: Number(r.lastInsertRowid) };
  }

  function query({ view = 'all', after = 0, limit = 500, agents = [] } = {}) {
    const conds = [];
    const params = [];
    if (after > 0) {
      conds.push('id > ?');
      params.push(after);
    }
    if (view === 'boss') {
      conds.push("(sender = 'boss' OR receiver = 'boss')");
    } else if (view.startsWith('agent:')) {
      const name = view.slice('agent:'.length);
      conds.push(MEMBER_CLAUSE);
      params.push(name, name, name);
    } else if (view.startsWith('project:')) {
      const names = agents.length ? agents : [view.slice('project:'.length)];
      const parts = [];
      for (const n of names) {
        parts.push(MEMBER_CLAUSE);
        params.push(n, n, n);
      }
      conds.push(`(${parts.join(' OR ')})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // after = 0 → latest N rows, returned ascending: take DESC then reverse in JS.
    const order = after > 0 ? 'ORDER BY id ASC' : 'ORDER BY id DESC';
    let rows = db
      .prepare(`SELECT ${ROW_COLS} FROM messages ${where} ${order} LIMIT ?`)
      .all(...params, limit);
    if (after === 0) rows = rows.reverse();
    return rows;
  }

  function unread(consumer = 'boss') {
    const b = bookmarkStmt.get(consumer);
    return db
      .prepare(`SELECT ${ROW_COLS} FROM messages WHERE id > ? ORDER BY id ASC`)
      .all(b ? b.last_seen_id : 0);
  }

  // throughId: bookmark through this row instead of MAX(id) — lets callers
  // snapshot a slice and never swallow rows inserted after it.
  function markSeen(consumer = 'boss', throughId) {
    let id = throughId;
    if (id === undefined) {
      const row = maxIdStmt.get();
      id = row && row.m !== null ? row.m : undefined; // no-op on empty table
    }
    if (id !== undefined) upsertBookmarkStmt.run(consumer, id);
  }

  function close() {
    db.close();
  }

  return { insert, query, unread, markSeen, close };
}
