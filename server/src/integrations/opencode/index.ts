// OpenCode integration — the stable internal agent interface (integrations/opencode/index.ts).
//
// Phase 4's composition root imports ONLY this module. Its public surface is
// EXACTLY (15 names): the factory, the three protocol-neutral port interfaces,
// the neutral event/session types, the neutral config/integration types, the
// three documented split points (createSessionResolver, composeWakePrompt,
// WAKE_PROMPT — assessment A6), and the neutral error type (PortError). There
// are NO star exports: the client (effective
// serverUrl, raw request/stream), discovery and its override, client-backed
// factories, and the rich OpenCodeRequestError stay INTERNAL — reachable only
// by module path (the test seam in client.ts), never from this entry point.
// Errors from the ports are NEUTRAL (PortError.code + safe message); rich
// transport details are logged inside the adapter and never cross out.
// No Fastify, no drizzle, no routes.
import { createOpenCodeClient } from './client.js';
import { createEventStream, type OpenCodeEventStream } from './events.js';
import { createPromptPort, type OpenCodePromptPort } from './prompts.js';
import { createSessionPort, type OpenCodeSessionPort } from './sessions.js';

// Neutral event/session contract types (Phase 4 implements resolvers with these).
export type { NormalizedEvent, SessionResolution, SessionResolver, SessionRole } from './events.js';
// The three port interfaces.
export type { OpenCodeEventStream } from './events.js';
export type { OpenCodeSessionPort } from './sessions.js';
export type { OpenCodePromptPort } from './prompts.js';
// The adapter's DOCUMENTED SPLIT POINTS (assessment A6), exported consciously so
// the composition root and the chat application consume ONLY this entry surface
// (no module-path reach-ins): createSessionResolver wires the per-event-line
// session→domain-actor mapping; WAKE_PROMPT/composeWakePrompt are the wake TEXT
// format the adapter owns byte-identically to bridge.mjs — slice CONSTRUCTION
// (unread selection, bookmark advance) stays chat application state. The AST
// surface guard's whitelist (test/opencode-client.test.ts) was extended for
// exactly these three names; nothing protocol-specific crosses with them.
export { createSessionResolver } from './sessions.js';
export { composeWakePrompt, WAKE_PROMPT } from './prompts.js';
// Neutral error contract (see errors.ts): code + safe message only.
export { PortError } from './errors.js';
export type { PortErrorCode } from './errors.js';

/** Plain config the caller may inject (assessment §6): ONLY the fallback URL
 *  and timeout — the effective server-URL discovery and all transport options
 *  stay inside the adapter. Validated by client.ts's zod schema at the seam. */
export interface OpenCodeIntegrationConfig {
  /** Optional fallback OpenCode server URL (a plain configured value, e.g.
   *  `LOBBY_OPENCODE_SERVER_URL` / `agents.json` `serverUrl`). */
  readonly fallbackServerUrl?: string | null;
  /** Upstream request timeout in ms (decision 4). Default 30 000. */
  readonly timeoutMs?: number;
}

export interface OpenCodeIntegration {
  readonly events: OpenCodeEventStream;
  readonly sessions: OpenCodeSessionPort;
  readonly prompts: OpenCodePromptPort;
}

/** Composition for Phase 4: resolves the effective server URL once (discovery
 *  + fallback, both internal to client.ts), then exposes ONLY the protocol-
 *  neutral ports over it. The sink is wired by the caller via
 *  `events.subscribe(handler, resolveSession)` — a plain injectable callback,
 *  NOT a route. The single `config` parameter (arity 1) is deliberate: no
 *  options object, no discovery override. */
export function createOpenCodeIntegration(config: OpenCodeIntegrationConfig): OpenCodeIntegration {
  const client = createOpenCodeClient(config);
  return {
    events: createEventStream(client),
    sessions: createSessionPort(client),
    prompts: createPromptPort(client),
  };
}


