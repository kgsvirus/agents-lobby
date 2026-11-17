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
  /** Inserts and returns the row in the wire shape (store.mjs:41-46).
   *  SYNCHRONOUS on purpose: inside a bus transaction() only synchronous
   *  SQLite work is possible (message row + message.created event must commit
   *  atomically). */
  insert(row: NewMessage): WireMessageRow;
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
   *  ingest transaction (atomic ingest contract). */
  readonly bus: EventBus;
}

export interface ChatDeps {
  readonly store: ChatMessageStore;
  readonly registry: ChatRegistry;
  readonly ports: ChatPorts;
}
