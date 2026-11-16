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
  const rowByIdStmt = db.prepare(`SELECT ${ROW_COLS} FROM messages WHERE id = ?`);
  const maxIdStmt = db.prepare('SELECT MAX(id) AS m FROM messages');
  const bookmarkStmt = db.prepare('SELECT last_seen_id FROM bookmarks WHERE consumer = ?');
  const upsertBookmarkStmt = db.prepare(
    `INSERT INTO bookmarks (consumer, last_seen_id) VALUES (?, ?)
     ON CONFLICT(consumer) DO UPDATE SET last_seen_id = excluded.last_seen_id`,
  );

  // SSE subscribers: notified with the full wire row on every insert.
  const insertSubscribers = new Set();

  function insert({ ts, from, to, body, sessionId = null }) {
    const r = insertStmt.run(ts, from, to, body, sessionId);
    const row = rowByIdStmt.get(Number(r.lastInsertRowid));
    for (const cb of insertSubscribers) cb(row);
    return { id: Number(r.lastInsertRowid) };
  }

  function onInsert(cb) {
    insertSubscribers.add(cb);
    return () => insertSubscribers.delete(cb);
  }

  function query({ view = 'all', after = 0, before = 0, limit = 500, agents = [] } = {}) {
    const conds = [];
    const params = [];
    let descending = false;
    if (before > 0) {
      conds.push('id < ?');
      params.push(before);
      descending = true; // older-page: fetch newest-first, then reverse
    } else if (after > 0) {
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
    // before/initial: DESC to find hasMore cheaply (fetch limit+1); after>0: ASC.
    const order = after > 0 && !descending ? 'ORDER BY id ASC' : 'ORDER BY id DESC';
    let rows = db
      .prepare(`SELECT ${ROW_COLS} FROM messages ${where} ${order} LIMIT ?`)
      .all(...params, limit + 1);
    // hasMore = an extra row exists in the fetch direction (upward: older
    // remain; catch-up: newer remain — the UI keeps refetching until false).
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    if (descending || after === 0) rows = rows.reverse();
    return { rows, hasMore };
  }

  function unread(consumer = 'boss') {
    const b = bookmarkStmt.get(consumer);
    return db
      .prepare(`SELECT ${ROW_COLS} FROM messages WHERE id > ? ORDER BY id ASC`)
      .all(b ? b.last_seen_id : 0);
  }

  function markSeen(consumer = 'boss', throughId) {
    let id = throughId;
    if (id === undefined) {
      const row = maxIdStmt.get();
      id = row && row.m !== null ? row.m : null;
    }
    if (id !== null) upsertBookmarkStmt.run(consumer, id); // no-op on empty table
  }

  // Latest message ts per view channel (F6 r2): no MAX(ts) full scans. Each
  // membership disjunct becomes a top-1 `ORDER BY id DESC LIMIT 1` on an
  // existing index (idx_msg_sender / idx_msg_receiver / rowid PK) — ts is
  // assigned at insert, so id order == ts order — combined via max(). The
  // list-LIKE disjunct is a rowid-desc scan with early exit (no usable index).
  // No schema migration; '' (empty table) maps to null. Still one statement.
  function lastActivity(agents = []) {
    const LIST = `(',' || REPLACE(receiver, ' ', '') || ',') LIKE '%,' || ? || ',%'`;
    const top = (cond) =>
      `ifnull((SELECT ts FROM messages WHERE ${cond} ORDER BY id DESC LIMIT 1), '')`;
    const sql = [
      `SELECT 'all' AS view, ifnull((SELECT ts FROM messages ORDER BY id DESC LIMIT 1), '') AS ts`,
      `SELECT 'boss' AS view, max(${top(`sender = 'boss'`)}, ${top(`receiver = 'boss'`)}) AS ts`,
      ...agents.map(
        (n) =>
          `SELECT 'agent:${n}' AS view, max(${top(`sender = ?`)}, ${top(
            `receiver = 'all'`,
          )}, ${top(`receiver = ?`)}, ${top(LIST)}) AS ts`,
      ),
    ].join(' UNION ALL ');
    const params = agents.flatMap((n) => [n, n, n]);
    const out = {};
    for (const r of db.prepare(sql).all(...params)) out[r.view] = r.ts === '' ? null : r.ts;
    return out;
  }

  function close() {
    db.close();
  }

  return { insert, onInsert, query, unread, markSeen, lastActivity, close };
}
