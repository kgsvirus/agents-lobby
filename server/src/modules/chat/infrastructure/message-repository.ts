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
import type { MessagePage, NewMessage, WireMessageRow } from '../domain/message.js';
import type { ChatMessageStore } from '../application/ports.js';

const ROW_COLS = 'id, ts AS time, sender AS "from", receiver AS "to", body AS text';

/** Duplicate-capture window around the INCOMING capture time (work order
 *  Task 1.2; final-review fix 1). Live evidence: canonical rows 1461/1462 and
 *  1463/1464 were 1-4 ms apart duplicates while two server instances captured
 *  the same event — each instance stamps its own capture time on one machine
 *  with one clock, so the guard only has to cover that few-ms offset. 100 ms is
 *  ~25x the observed skew, and 50x narrower than the previous 5 s, which
 *  swallowed DELIBERATE repeats ("yes" ... "yes" seconds apart).
 *
 *  shortcut: content + capture-time identity, NOT a source event id — the
 *  normalized capture event carries no upstream id (`ts` is this instance's
 *  capture time, integrations/opencode/events.ts:39-41), so two identical
 *  bodies captured within 100 ms by the same sender are still treated as one
 *  event. Upgrade when the adapter exposes a stable OpenCode event/item id (put
 *  it on NormalizedEvent and dedupe on that instead of ts). */
const DEDUP_WINDOW_MS = 100;

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
  readonly #dupStmt: Database.Statement;
  readonly #rowByIdStmt: Database.Statement;
  readonly #bookmarkStmt: Database.Statement;
  readonly #upsertBookmarkStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#insertStmt = db.prepare(
      'INSERT INTO messages (ts, sender, receiver, body, session_id) VALUES (?, ?, ?, ?, ?)',
    );
    // Duplicate-capture lookup (work order Task 1.2; review fixes 3-4). The
    // db-level check is the choke point every event-capture insert goes
    // through and holds ACROSS connections — two connections to one file are
    // the dual-instance failure mode (an in-process set would not cover it).
    // Serialization across connections comes from the ingest transaction's
    // BEGIN IMMEDIATE (bus.ts) + the connection busy_timeout (client.ts):
    // the check cannot interleave with another instance's open ingest. `IS`
    // gives null-safe equality (the webhook path stores a NULL receiver).
    // The ts bounds are around the INCOMING capture ts (± DEDUP_WINDOW_MS),
    // not wall-clock now: a duplicate committed while a busy retry waited is
    // still recognized however long that wait took (final-review fix 1).
    this.#dupStmt = db.prepare(
      `SELECT ${ROW_COLS} FROM messages
       WHERE ts >= ? AND ts <= ? AND sender IS ? AND receiver IS ? AND body IS ?
       ORDER BY id DESC LIMIT 1`,
    );
    this.#rowByIdStmt = db.prepare(`SELECT ${ROW_COLS} FROM messages WHERE id = ?`);
    this.#bookmarkStmt = db.prepare('SELECT last_seen_id FROM bookmarks WHERE consumer = ?');
    this.#upsertBookmarkStmt = db.prepare(
      `INSERT INTO bookmarks (consumer, last_seen_id) VALUES (?, ?)
       ON CONFLICT(consumer) DO UPDATE SET last_seen_id = excluded.last_seen_id`,
    );
  }

  insert(
    row: NewMessage,
    dedupEventCapture = false,
  ): { readonly row: WireMessageRow; readonly inserted: boolean } {
    // Duplicate-capture guard (work order Task 1.2; review fix 3): applies
    // ONLY to OpenCode event captures (the listener path). A second capture
    // of the SAME event (identical sender + null-safe receiver + body within
    // the capture-skew window) is SKIPPED + logged — nothing stored, the
    // original row untouched; the original row is returned so the ingest
    // transaction keeps its shape, and `inserted:false` lets the caller skip
    // the message.created event (no creation happened — final-review fix 4).
    // Explicit inserts (/send fan-out, legacy /webhook) never dedup: two
    // identical DELIBERATE sends are two real messages.
    if (dedupEventCapture) {
      const captureMs = Date.parse(row.ts);
      const anchor = Number.isNaN(captureMs) ? Date.now() : captureMs;
      const dup = this.#dupStmt.get(
        new Date(anchor - DEDUP_WINDOW_MS).toISOString(),
        new Date(anchor + DEDUP_WINDOW_MS).toISOString(),
        row.from,
        row.to,
        row.body,
      ) as RawWireRow | undefined;
      if (dup !== undefined) {
        console.warn(
          `[chat] duplicate capture skipped: identical row ${dup.id} within ${DEDUP_WINDOW_MS}ms (ts=${row.ts}, from=${row.from}, to=${row.to})`,
        );
        return { row: toWire(dup), inserted: false };
      }
    }
    const r = this.#insertStmt.run(row.ts, row.from, row.to, row.body, row.sessionId);
    return { row: toWire(this.#rowByIdStmt.get(Number(r.lastInsertRowid))), inserted: true };
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

  /** The connection's current SQLite busy_timeout (ms). SQLite names the
   *  `PRAGMA busy_timeout` result column `timeout` — NOT `busy_timeout`;
   *  reading the wrong name yields undefined and a 0 fallback, which would
   *  silently turn the busy handler off. */
  busyTimeout(): number {
    const row = this.#db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
    return Number(row?.timeout ?? 0);
  }

  /** Sets the connection's busy_timeout (ms). The ingest retry lowers it per
   *  attempt and RESTORES the saved value afterwards (review round 5). */
  setBusyTimeout(ms: number): void {
    this.#db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))}`);
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
