// Agents domain — pure types and rules. No Fastify, no drizzle.
//
// The registry types mirror the agents.json entry shape (agents.example.json).
// They are declared here STRUCTURALLY identical to the chat module's
// RegistrySnapshot (modules/chat/application/ports.ts) so the shared Phase 4
// reader satisfies this port without a cross-module import.

/** One agents.json entry (the `agents` array; the boss entry has the same shape). */
export interface Agent {
  readonly name: string;
  readonly project: string;
  readonly session: string;
}

/** A validated registry snapshot. The boss is null only in the documented
 *  fresh-clone state (agents.json absent → empty registry). */
export interface RegistrySnapshot {
  readonly serverUrl: string | null;
  readonly boss: Agent | null;
  readonly agents: readonly Agent[];
}

/** GET /api/agents wire entry — bridge.mjs:258-262 serves {name, project}
 *  ONLY (the session and the boss entry never cross this boundary). */
export interface AgentWire {
  readonly name: string;
  readonly project: string;
}

export function toAgentWire(agent: Agent): AgentWire {
  return { name: agent.name, project: agent.project };
}

/** The `projects` mirror rows: DISTINCT project grouping strings of the
 *  registered agents, in first-appearance order (bridge.mjs:277-282 — project
 *  is a plain grouping string on agents). The boss entry is not a source: it
 *  is not part of the agents.json `agents` array and never reaches
 *  /api/agents. */
export function projectNames(agents: readonly Agent[]): string[] {
  return [...new Set(agents.map((a) => a.project))];
}
