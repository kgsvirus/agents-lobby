// OpenCode integration — session-facing operations (integrations/opencode/sessions.ts).
//
// Extracted from bridge.mjs: the wake-coalescing inbox check (bridge.mjs:102-106)
// and the session-handle → domain-actor identity resolution the listener performs
// per event line (bridge.mjs:160-165).
//
// Boundary: the GET /api/session/{id}/inbox wire shape and the
// `item.type === "user"` interpretation stay INSIDE the adapter; callers receive
// only a protocol-neutral boolean (assessment §6). The registry file itself is
// the application's state (agents module, Phase 5) — it is injected here as a
// loader and validated at this trust boundary.
import { z } from 'zod';
import type { OpenCodeHttpClient } from './client.js';
import { toPortError } from './errors.js';
import type { SessionResolver } from './events.js';

const inboxResponseSchema = z.object({
  data: z.array(z.looseObject({ type: z.string().optional() })),
});

export interface OpenCodeSessionPort {
  /** Wake-coalescing check (bridge.mjs:102-106): performs the inbox fetch AND
   *  the item.type === "user" interpretation internally; the caller receives
   *  only a protocol-neutral boolean. Failures reject with the NEUTRAL
   *  PortError (details logged inside the adapter) — the caller's wake
   *  orchestration decides what to do with a failed coalescing check, exactly
   *  like bridge's wakeBoss catch (a broken check must not silently trigger
   *  duplicate wakes). Transport/malformed-payload distinction is `code`. */
  hasPendingUserInput(sessionId: string): Promise<boolean>;
}

export function createSessionPort(client: OpenCodeHttpClient): OpenCodeSessionPort {
  return {
    async hasPendingUserInput(sessionId) {
      try {
        const res = await client.request(`/api/session/${encodeURIComponent(sessionId)}/inbox`);
        const parsed = inboxResponseSchema.parse(res); // trust boundary: malformed → throw
        return parsed.data.some((item) => item.type === 'user');
      } catch (err) {
        throw toPortError(`pending-input check for ${sessionId}`, err);
      }
    },
  };
}

// Registry snapshot shape the bridge actually reads (agents.json; example
// agents.example.json; consumed at bridge.mjs:160-165). Extra fields are kept
// (loose) — the bridge never restricts the entry shape.
const registrySnapshotSchema = z.object({
  boss: z.looseObject({ session: z.string().min(1) }),
  agents: z.array(z.looseObject({ name: z.string().min(1), session: z.string().min(1) })),
});

/** Maps session handles to domain actor names, exactly as the bridge resolves
 *  sessions in its listener (bridge.mjs:160-165): the boss session wins first
 *  (name fixed to "boss" — the bridge uses the literal, not the registry entry),
 *  then agent sessions by their `session` id; anything else is unknown → null
 *  (the bridge skips such events, bridge.mjs:165). A registry load/parse failure
 *  → null for that event (the next event retries — matches the bridge, where a
 *  failed per-line registry read aborts the line and the stream reconnects). */
export function createSessionResolver(loadRegistry: () => unknown): SessionResolver {
  return (sessionId) => {
    let raw: unknown;
    try {
      raw = loadRegistry();
    } catch {
      return null;
    }
    const parsed = registrySnapshotSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (sessionId === parsed.data.boss.session) return { name: 'boss', role: 'boss' };
    const agent = parsed.data.agents.find((a) => a.session === sessionId);
    return agent ? { name: agent.name, role: 'agent' } : null;
  };
}
