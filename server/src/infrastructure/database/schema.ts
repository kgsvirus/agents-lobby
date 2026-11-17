// Baseline schema (Phase 2) — reproduces the EXISTING legacy tables exactly
// (store.mjs:7-15 / assessment §5: columns are sender/receiver/body, NOT from/to —
// the `from`/`to`/`text` names are wire aliases only), plus the adjudicated
// `events` table: one shared monotonic sequence used as the single
// `Last-Event-ID` cursor for ALL SSE event types (assessment §7).
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: text('ts').notNull(),
    sender: text('sender').notNull(),
    receiver: text('receiver'),
    body: text('body').notNull(),
    sessionId: text('session_id'),
  },
  (table) => [
    index('idx_msg_receiver').on(table.receiver, table.id),
    index('idx_msg_sender').on(table.sender, table.id),
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

// Read-only mirror of agents.json (Coordinator Phase 2 ruling, Boss-confirmed):
// the registry FILE stays the runtime source of truth (decision 3); this table
// is refreshed on every registry read (re-read per request — bridge-faithful).
// ROWID-KEYED (no name PK — rebuilt additively in 0003): the bridge serves ALL
// registry entries, INCLUDING duplicate names (bridge.mjs:258 maps the whole
// array; uniqueness is NOT part of the agents.json contract), so the mirror
// must hold every entry.
export const registryMirror = sqliteTable('registry_mirror', {
  name: text('name').notNull(),
  role: text('role').notNull(), // 'boss' | 'agent'
  project: text('project').notNull(),
  session: text('session').notNull(),
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
// session} — agents.example.json). The boss lives only in `registry_mirror`.
// ROWID-KEYED (no name PK — rebuilt additively in 0003): duplicate agent names
// are valid agents.json content (the bridge maps and serves every entry,
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
