// Agents application — port interfaces (modules/agents/application).
//
// The application orchestrates in domain terms only. The agents.json file and
// persistence (drizzle) live behind these interfaces; the composition root
// (app.ts) injects the concrete adapters. No Fastify, no drizzle here.
import type { Agent, RegistrySnapshot } from '../domain/agent.js';

/** Registry read port — per-request re-read semantics (decision 3, Phase 2
 *  ruling: the FILE stays the runtime source of truth). Structurally
 *  satisfied by the shared Phase 4 JsonRegistryReader
 *  (infrastructure/registry/reader.ts), whose read() also refreshes the
 *  read-only registry_mirror table as an established side effect (chat reads
 *  the registry directly through its port — the table is a projection, not
 *  chat's source); nothing about that contract changes for chat. */
export interface RegistrySource {
  read(): Promise<RegistrySnapshot>;
}

/** Mirror persistence port — the read-only db projection of agents.json
 *  (decision 3). Full-rewrite replace on every sync (the registry FILE is the
 *  state; no incremental merge, no CRUD). */
export interface AgentMirrorStore {
  replaceAll(agents: readonly Agent[]): void;
  /** Agents in registry file order (bridge.mjs:258 — the bridge's map
   *  preserves array order; the mirror reproduces it via `ordinal`). */
  listAgents(): Agent[];
}

export interface AgentsDeps {
  readonly registry: RegistrySource;
  readonly mirror: AgentMirrorStore;
}
