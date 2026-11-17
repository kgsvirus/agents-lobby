// Agents application — the agents.json mirror orchestration (decision 3).
//
// agents.json REMAINS the runtime registry; these tables are the read-only
// mirror used for queries/API. NO CRUD: the full-rewrite replace below is the
// only write path. Behavior equivalence with the bridge is the bar; methods
// cite their bridge source.
import type { AgentWire, RegistrySnapshot } from '../domain/agent.js';
import { toAgentWire } from '../domain/agent.js';
import type { AgentsDeps } from './ports.js';

export class AgentsService {
  readonly #registry: AgentsDeps['registry'];
  readonly #mirror: AgentsDeps['mirror'];

  constructor(deps: AgentsDeps) {
    this.#registry = deps.registry;
    this.#mirror = deps.mirror;
  }

  /** Startup mirror sync (decision 3 — the bridge reads agents.json once at
   *  startup, bridge.mjs:14-19). A null snapshot (absent/unreadable/malformed
   *  registry at startup) leaves an EMPTY mirror — the documented graceful
   *  fresh-clone default; per-request reads re-sync it. */
  syncStartup(snapshot: RegistrySnapshot | null): void {
    this.#mirror.replaceAll(snapshot === null ? [] : snapshot.agents);
  }

  /** Per-request re-read + mirror refresh (bridge.mjs:45-49 re-reads the file
   *  per request; the Phase 2 ruling mirrors it into the db each read). */
  async sync(): Promise<void> {
    this.#mirror.replaceAll((await this.#registry.read()).agents);
  }

  /** GET /api/agents source (bridge.mjs:255-264): re-read per request, then
   *  serve the {name, project} projection in registry file order. */
  async listAgents(): Promise<AgentWire[]> {
    await this.sync();
    return this.#mirror.listAgents().map(toAgentWire);
  }
}
