// Baseline schema (Phase 2) — reproduces the EXISTING legacy tables exactly
// (store.mjs:7-15 / assessment §5: columns are sender/receiver/body, NOT from/to —
// the `from`/`to`/`text` names are wire aliases only), plus the adjudicated
// `events` table: one shared monotonic sequence used as the single
// `Last-Event-ID` cursor for ALL SSE event types (assessment §7).
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: text('ts').notNull(),
    sender: text('sender').notNull(),
    receiver: text('receiver'),
    body: text('body').notNull(),
    sessionId: text('session_id'),
    // Peer-messaging columns (PT-2). `message_id` is the client-supplied
    // idempotency key: unique, so a retried peer send cannot archive twice.
    messageId: text('message_id'),
    // Armed by a peer `/send`: the sender's own turn transcript must not be
    // archived as a second message. Cleared on that session's next inbound.
    captureSuppressed: integer('capture_suppressed', { mode: 'boolean' }).notNull().default(false),
    // 0 = queued but not confirmed delivered, 1 = delivered or legacy row,
    // 2 = startup reconciliation retried it and gave up (once, ever).
    deliveryState: integer('delivery_state').notNull().default(1),
  },
  (table) => [
    index('idx_msg_receiver').on(table.receiver, table.id),
    index('idx_msg_sender').on(table.sender, table.id),
    // Idempotency is SENDER-SCOPED: keys are client chosen, so the pair is the
    // identity of a logical send, never a global name one agent could squat.
    uniqueIndex('idx_msg_message_id').on(table.messageId, table.sender),
  ],
);

// Nullability note: the legacy DDL is `consumer TEXT PRIMARY KEY` — SQLite
// allows NULL in a non-integer PK on a rowid table, and pragma table_info
// reports notnull=0. Drizzle adds NOT NULL for INLINE .primaryKey() fields,
// so the PK is declared at TABLE level instead, which emits `PRIMARY KEY
// (`consumer`)` with the column left nullable — matching legacy exactly.
export const bookmarks = sqliteTable(
  'bookmarks',
  {
    consumer: text('consumer'),
    lastSeenId: integer('last_seen_id').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.consumer] })],
);

// The single SSE cursor: every published event gets an id from this one
// AUTOINCREMENT sequence regardless of type, so a status event can never
// permanently skip a later message during Last-Event-ID replay.
export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  payload: text('payload').notNull(), // JSON
  ts: text('ts').notNull(),
});

// Phase 5 projects/agents mirror (decision 3 — read-only projection of
// agents.json, refreshed on every registry read; NO registry CRUD).
//
// `projects` is the agent → project grouping foundation. The bridge treats
// project as a PLAIN grouping string on agents (bridge.mjs:277-282 filters
// `a.project === view.slice("project:".length)`; the dashboard aggregates
// client-side, bridge.mjs:288-290), so the table holds exactly that string —
// no id, no FK, no speculative columns. Rows are the DISTINCT agent project
// values in first-appearance order; the boss entry is NOT a project source
// (it never appears in the agents.json `agents` array or /api/agents).
export const projects = sqliteTable('projects', {
  name: text('name').primaryKey(),
});

// `agents` mirrors the agents.json `agents` ENTRIES exactly ({name, project,
// session} — agents.example.json). The boss is NOT mirrored (it is not part of
// the `agents` array); it is read from agents.json itself on every registry
// read. ROWID-KEYED (no name PK — rebuilt additively in 0003): duplicate agent
// names are valid agents.json content (the bridge maps and serves every entry,
// bridge.mjs:258) — uniqueness is NOT enforced at the boundary, so the mirror
// must insert all of them. `ordinal` is the entry's index in the agents array
// and is the one column beyond the entry shape: the mirror serves
// GET /api/agents and the bridge's response preserves FILE order
// (bridge.mjs:258), which a db query can only reproduce with an order column.
export const agents = sqliteTable('agents', {
  name: text('name').notNull(),
  project: text('project').notNull(),
  session: text('session').notNull(),
  ordinal: integer('ordinal').notNull(),
});
