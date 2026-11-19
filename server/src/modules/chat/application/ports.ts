// Chat application — port interfaces (modules/chat/application).
//
// The application orchestrates in domain terms only. Persistence (drizzle/raw
// SQLite), the agents.json file, and the OpenCode transport live behind these
// interfaces; the composition root (app.ts) injects the concrete adapters.
// No Fastify, no drizzle, no OpenCode-specific logic here.
// Both port types come through the adapter's ENTRY SURFACE (index.ts).
import type { EventBus } from '../../../infrastructure/events/bus.js';
import type {
  OpenCodePromptPort,
  OpenCodeSessionPort,
} from '../../../integrations/opencode/index.js';
import type {
  MessagePage,
  MessageQuery,
  NewMessage,
  WireMessageRow,
} from '../domain/message.js';

/** Persistence port — the EXACT store.mjs semantics (views, direction-dependent
 *  ordering, limit+1 hasMore, unread/markSeen bookkeeping, per-view
 *  lastActivity). Implemented by the chat infrastructure layer. */
export interface ChatMessageStore {
  /** Inserts and reports the row in the wire shape (store.mjs:41-46) plus
   *  whether a row was actually inserted. SYNCHRONOUS on purpose: inside a bus
   *  transaction() only synchronous SQLite work is possible (message row +
   *  message.created event must commit atomically). `dedupEventCapture` arms
   *  the duplicate-capture guard and is passed ONLY by the OpenCode-listener
   *  capture path: deliberate inserts (/send fan-out, legacy /webhook) are
   *  never deduped — history must agree with the prompts actually delivered.
   *  A skipped duplicate returns the EXISTING row with `inserted:false`; the
   *  caller must then persist no message.created (nothing was created). */
  insert(
    row: NewMessage,
    dedupEventCapture?: boolean,
  ): { readonly row: WireMessageRow; readonly inserted: boolean };
  /** The connection's current SQLite busy_timeout (ms). The ingest retry
   *  saves it, caps each retry attempt to the remaining budget, and RESTORES
   *  it afterwards (review round 5) — the connection is SHARED with the
   *  registry mirror transactions, which have no retry loop. The
   *  read-cap-restore section is serialized per service (async ingest chain,
   *  final-review fix round 2) so an overlapping save never snapshots another
   *  save's temporary cap as its "original" value. */
  busyTimeout(): number;
  /** Sets the connection's busy_timeout (ms) — used by the ingest retry to
   *  cap an attempt's driver wait and to restore the saved value. */
  setBusyTimeout(ms: number): void;
  query(params: MessageQuery & { readonly agents: readonly string[] }): MessagePage;
  unread(consumer: string): WireMessageRow[];
  markSeen(consumer: string, throughId: number): void;
  lastActivity(agentNames: readonly string[]): Record<string, string | null>;
}

/** One registry entry (agents.json shape; agents.example.json). */
export interface RegistryEntry {
  readonly name: string;
  readonly project: string;
  readonly session: string;
}

/** A validated registry snapshot. The boss is null only in the documented
 *  fresh-clone state (agents.json absent → empty registry). */
export interface RegistrySnapshot {
  readonly serverUrl: string | null;
  readonly boss: RegistryEntry | null;
  readonly agents: readonly RegistryEntry[];
}

/** Registry port (bridge-faithful re-read semantics — Coordinator Phase 2
 *  ruling): every read() re-reads agents.json AND refreshes the db mirror
 *  table, so agents added at runtime are usable without a restart. The sync
 *  raw loader feeds the Phase 3 session resolver (per-event-line re-read). */
export interface ChatRegistry {
  read(): Promise<RegistrySnapshot>;
  /** Raw registry value for createSessionResolver (throws on malformed/present-
   *  but-broken file; the resolver treats a throw as "unknown session"). */
  loadSync(): unknown;
}

/** The Phase 3 ports the chat application consumes (protocol-neutral). */
export interface ChatPorts {
  readonly prompts: OpenCodePromptPort;
  readonly sessions: OpenCodeSessionPort;
  /** The Phase 2 bus: message.created is persisted + fanned out inside the
   *  ingest transaction (atomic ingest contract). Structural on purpose
   *  (review round 4): tests wrap/count the real bus through a proxy. */
  readonly bus: Pick<EventBus, 'transaction'>;
}

export interface ChatDeps {
  readonly store: ChatMessageStore;
  readonly registry: ChatRegistry;
  readonly ports: ChatPorts;
  /** Total SQLITE_BUSY retry budget for the ingest transaction (review round
   *  3): every attempt's synchronous driver busy_timeout wait is capped to a
   *  brief interval, the attempts are separated by an ASYNC nap that yields
   *  the event loop, and the transaction retries until this budget is
   *  exhausted; then the capture is lost LOUDLY (CAPTURE LOST log with the
   *  row's identifying metadata, body redacted). Default 15 s; tests shorten
   *  it. */
  readonly busyRetryBudgetMs?: number;
}
