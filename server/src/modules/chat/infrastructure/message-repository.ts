// Chat infrastructure — message repository (modules/chat/infrastructure).
//
// Verbatim port of store.mjs's SQL semantics over the SAME tables
// (messages/bookmarks) using the raw better-sqlite3 handle (the same pattern
// the event bus uses): wire alias (store.mjs:17), D11 membership clause
// (store.mjs:20), direction-dependent pagination with limit+1 hasMore
// (store.mjs:53-92), unread/markSeen bookkeeping (store.mjs:94-108), and the
// per-view lastActivity top-1 index scans (store.mjs:116-134). Result shapes
// are byte-equivalent to the legacy store for equivalent inputs.
//
// insert() is deliberately SYNCHRONOUS: it runs inside EventBus.transaction()
// next to the message.created persist (atomic ingest; the bus connection is
// the same handle, so the insert joins the transaction).
import type Database from 'better-sqlite3';
import { wireMessageSchema, type WireMessage } from '../../../shared/schemas/wire.js';
import type { MessagePage, NewMessage } from '../domain/message.js';
import type { ChatMessageStore } from '../application/ports.js';

const ROW_COLS = 'id, ts AS time, sender AS "from", receiver AS "to", body AS text';

// D11 membership: receiver = 'all' OR exact OR comma-list containing name (spaces normalized).
const MEMBER_CLAUSE =
  "(sender = ? OR receiver = 'all' OR receiver = ? OR (',' || REPLACE(receiver, ' ', '') || ',') LIKE '%,' || ? || ',%')";

interface RawWireRow {
  id: number;
  time: string;
  from: string;
  to: string | null;
  text: string;
}

function toWire(row: unknown): WireMessage {
  return wireMessageSchema.parse(row);
}

export class ChatMessageRepository implements ChatMessageStore {
  readonly #db: Database.Database;
  readonly #insertStmt: Database.Statement;
  readonly #rowByIdStmt: Database.Statement;
  readonly #bookmarkStmt: Database.Statement;
  readonly #upsertBookmarkStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#insertStmt = db.prepare(
      'INSERT INTO messages (ts, sender, receiver, body, session_id) VALUES (?, ?, ?, ?, ?)',
    );
    this.#rowByIdStmt = db.prepare(`SELECT ${ROW_COLS} FROM messages WHERE id = ?`);
    this.#bookmarkStmt = db.prepare('SELECT last_seen_id FROM bookmarks WHERE consumer = ?');
    this.#upsertBookmarkStmt = db.prepare(
      `INSERT INTO bookmarks (consumer, last_seen_id) VALUES (?, ?)
       ON CONFLICT(consumer) DO UPDATE SET last_seen_id = excluded.last_seen_id`,
    );
  }

  insert(row: NewMessage): WireMessage {
    const r = this.#insertStmt.run(row.ts, row.from, row.to, row.body, row.sessionId);
    return toWire(this.#rowByIdStmt.get(Number(r.lastInsertRowid)));
  }

  query(params: {
    view: string;
    after: number;
    before: number;
    limit: number;
    agents: readonly string[];
  }): MessagePage {
    const conds: string[] = [];
    const params_: unknown[] = [];
    let descending = false;
    if (params.before > 0) {
      conds.push('id < ?');
      params_.push(params.before);
      descending = true; // older-page: fetch newest-first, then reverse
    } else if (params.after > 0) {
      conds.push('id > ?');
      params_.push(params.after);
    }
    if (params.view === 'boss') {
      conds.push("(sender = 'boss' OR receiver = 'boss')");
    } else if (params.view.startsWith('agent:')) {
      const name = params.view.slice('agent:'.length);
      conds.push(MEMBER_CLAUSE);
      params_.push(name, name, name);
    } else if (params.view.startsWith('project:')) {
      const names = params.agents.length ? params.agents : [params.view.slice('project:'.length)];
      const parts: string[] = [];
      for (const n of names) {
        parts.push(MEMBER_CLAUSE);
        params_.push(n, n, n);
      }
      conds.push(`(${parts.join(' OR ')})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // before/initial: DESC to find hasMore cheaply (fetch limit+1); after>0: ASC.
    const order = params.after > 0 && !descending ? 'ORDER BY id ASC' : 'ORDER BY id DESC';
    let rows = this.#db
      .prepare(`SELECT ${ROW_COLS} FROM messages ${where} ${order} LIMIT ?`)
      .all(...params_, params.limit + 1) as RawWireRow[];
    // hasMore = an extra row exists in the fetch direction (upward: older
    // remain; catch-up: newer remain — the UI keeps refetching until false).
    const hasMore = rows.length > params.limit;
    if (hasMore) rows = rows.slice(0, params.limit);
    if (descending || params.after === 0) rows = rows.reverse();
    return { rows: rows.map(toWire), hasMore };
  }

  unread(consumer: string): WireMessage[] {
    const b = this.#bookmarkStmt.get(consumer) as { last_seen_id: number } | undefined;
    const rows = this.#db
      .prepare(`SELECT ${ROW_COLS} FROM messages WHERE id > ? ORDER BY id ASC`)
      .all(b ? b.last_seen_id : 0) as RawWireRow[];
    return rows.map(toWire);
  }

  markSeen(consumer: string, throughId: number): void {
    this.#upsertBookmarkStmt.run(consumer, throughId);
  }

  lastActivity(agentNames: readonly string[]): Record<string, string | null> {
    const LIST = `(',' || REPLACE(receiver, ' ', '') || ',') LIKE '%,' || ? || ',%'`;
    const top = (cond: string) =>
      `ifnull((SELECT ts FROM messages WHERE ${cond} ORDER BY id DESC LIMIT 1), '')`;
    // Labels ('agent:<name>') are BOUND, never interpolated: registry names are
    // z.string().min(1), so an apostrophe (O'Reilly) is legal and a literal
    // `'agent:${n}'` would break (or alter) the SQL.
    const sql = [
      `SELECT 'all' AS view, ifnull((SELECT ts FROM messages ORDER BY id DESC LIMIT 1), '') AS ts`,
      `SELECT 'boss' AS view, max(${top(`sender = 'boss'`)}, ${top(`receiver = 'boss'`)}) AS ts`,
      ...agentNames.map(
        () =>
          `SELECT 'agent:' || ? AS view, max(${top(`sender = ?`)}, ${top(
            `receiver = 'all'`,
          )}, ${top(`receiver = ?`)}, ${top(LIST)}) AS ts`,
      ),
    ].join(' UNION ALL ');
    const stmtParams = agentNames.flatMap((n) => [n, n, n, n]); // label, sender, receiver, list
    const out: Record<string, string | null> = {};
    const rows = this.#db.prepare(sql).all(...stmtParams) as Array<{ view: string; ts: string }>;
    for (const r of rows) out[r.view] = r.ts === '' ? null : r.ts;
    return out;
  }
}
