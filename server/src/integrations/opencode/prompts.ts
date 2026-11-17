// OpenCode integration — prompt sending (integrations/opencode/prompts.ts).
//
// Port of the bridge's prompt transports: the /send fan-out target call and the
// /prompt to-boss call are the SAME upstream operation (bridge.mjs:86-92) —
// POST /api/session/{id}/prompt with `delivery: "queue"`. The delivery choice is
// adapter-internal: the port takes ONLY (sessionId, text); no `delivery` option
// or other OpenCode request option crosses the boundary (assessment §6).
//
// lastPromptFrom split (adjudication, keep visible): the who-prompted-whom map
// is APPLICATION state owned by Phase 4's chat module — it cannot live behind
// a stateless transport. This adapter contributes the ACK SIGNALS chat needs:
// prompt() RESOLVING = delivered (chat records lastPromptFrom[name] BEFORE
// awaiting, bridge.mjs:416 — a reply may race the send), REJECTING = skipped
// (the bridge's Promise.allSettled fan-out accounting, bridge.mjs:414-424, is
// Phase 4's orchestration over these signals).
//
// Boss wake path: this module owns the wake-prompt TEXT FORMAT (byte-identical
// to bridge.mjs:94,114-118 — see WAKE_PROMPT / composeWakePrompt / formatWakeLine
// / parseWakeLine). Slice CONSTRUCTION (which unread rows go in, bookmark
// advance, empty-slice semantics, bridge.mjs:111-124) is Phase 4 chat —
// documented, not built here.
import type { OpenCodeHttpClient } from './client.js';
import { toPortError } from './errors.js';

export interface OpenCodePromptPort {
  /** POST /api/session/{sessionId}/prompt (bridge.mjs:86-92). Resolves = the
   *  upstream accepted the queued prompt (ack); rejects with the NEUTRAL
   *  PortError = not delivered (fan-out "skipped" — Phase 4 branches on
   *  `code`, details are logged inside the adapter). */
  prompt(sessionId: string, text: string): Promise<void>;
  /** Neutral availability check (bridge.mjs:99-100, 372-373, 399-400): TRUE
   *  only when an effective server URL was resolved at creation (discovery or
   *  fallback). No URL/transport detail crosses — just the boolean the bridge's
   *  `!SERVER_URL` checks produce. False = the upstream was never configured;
   *  callers fail fast with the bridge's semantics instead of attempting
   *  prompts that can only fail. (Coordinator ruling, Phase 4 review round:
   *  deliberately extends the pinned port shape.) */
  isAvailable(): boolean;
}

export function createPromptPort(client: OpenCodeHttpClient): OpenCodePromptPort {
  return {
    isAvailable: () => client.serverUrl !== null,
    async prompt(sessionId, text) {
      try {
        await client.request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, delivery: 'queue' }),
        });
        // Response body intentionally discarded, like the bridge (bridge.mjs:86-92).
      } catch (err) {
        throw toPortError(`prompt delivery to ${sessionId}`, err);
      }
    },
  };
}

/**
 * BYTE-IDENTICAL wake prompt constant (bridge.mjs:94). Load-bearing on BOTH
 * sides: it is the boss agent's AGENTS.md wake trigger, and the echo filter
 * (wherever capture policy lives) distinguishes the bridge's own wake prompt by
 * EXACT equality and the `WAKE_PROMPT + "\n\n"` prefix (bridge.mjs:172-178 — a
 * real message that merely BEGINS with the wake text must still capture).
 * Never paraphrase, never trim, never change case.
 */
export const WAKE_PROMPT = '[message received]';

/** One wake-slice line in the bridge's exact marker format
 *  (bridge.mjs:117): `[time] [from: X] [to: Y] text`. `to` may be null — the
 *  bridge renders it as the literal `null` inside the brackets. */
export interface WakeSliceLine {
  readonly time: string;
  readonly from: string;
  readonly to: string | null;
  readonly text: string;
}

export function formatWakeLine(line: WakeSliceLine): string {
  return `[${line.time}] [from: ${line.from}] [to: ${line.to}] ${line.text}`;
}

/** The exact wake text the bridge sends (bridge.mjs:114-118): the bare
 *  wake prompt when the slice is empty, else the prompt + "\n\n" + marker
 *  lines joined by "\n". Slice row SELECTION is Phase 4 chat's; the byte
 *  format is this module's. */
export function composeWakePrompt(lines: readonly WakeSliceLine[]): string {
  return lines.length
    ? WAKE_PROMPT + '\n\n' + lines.map(formatWakeLine).join('\n')
    : WAKE_PROMPT;
}

/** Parse-back of a wake-slice marker line (assessment §6: the format is
 *  composed and parsed HERE, never downstream). Returns null for any line
 *  that is not in the marker format. `to` keeps its raw bracket token (the
 *  bridge renders a null receiver as the string "null" — callers map it). */
export function parseWakeLine(line: string): WakeSliceLine | null {
  const match = /^\[([^\]]*)\] \[from: ([^\]]*)\] \[to: ([^\]]*)\] (.*)$/.exec(line);
  if (!match) return null;
  return {
    time: match[1] ?? '',
    from: match[2] ?? '',
    to: match[3] ?? '',
    text: match[4] ?? '',
  };
}
