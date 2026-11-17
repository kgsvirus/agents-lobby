// OpenCode integration — event-stream subscription (integrations/opencode/events.ts).
//
// Port of bridge.mjs's listener (bridge.mjs:132-212): one GET /api/event SSE
// subscription, `data:`-line parsing, per-event validation at the trust
// boundary (zod), and ALL OpenCode interpretation — session-reply capture
// detection (`session.text.ended`) and inbox-item semantics
// (`session.inbox.enqueued`, item.type === "user") happen HERE and are emitted
// as protocol-neutral NormalizedEvents {kind, from, to, body, sessionId, ts}.
//
// The single internal sink is the injectable `handler` passed to subscribe();
// Phase 4 (chat module) will connect it to capture policy + the event bus.
// No Fastify, no drizzle, no OpenCode wire shapes cross out of this module.
import { z } from 'zod';
import type { OpenCodeHttpClient } from './client.js';

export type SessionRole = 'boss' | 'agent';

/** Domain actor the adapter resolved a session handle to. The boss has the
 *  fixed name "boss" (bridge.mjs:162,187 — the registry's literal role name;
 *  the registry's boss entry name is never used by the bridge). */
export interface SessionResolution {
  readonly name: string;
  readonly role: SessionRole;
}

/** Provided by the application (registry state) — supplies domain NAMES; the
 *  adapter interprets, it does not know the registry (assessment §4). */
export type SessionResolver = (sessionId: string) => SessionResolution | null;

/** Protocol-neutral event (the ACCEPTED contract, assessment §6):
 *  - kind "inbox": human input captured from a `user` inbox item; from = "human",
 *    to = resolved session-owner name. Capture policy (boss-only filter, echo
 *    suppression against prompts the application itself enqueued) is Phase 4
 *    chat's — the adapter deliberately emits resolvable inbox items, including
 *    wake-prompt echoes, and makes NO what-to-store decision.
 *  - kind "reply": session-reply capture (session.text.ended with text); from =
 *    resolved session name, to = null — chat routes it via its last-prompt
 *    record with the "boss" fallback (bridge.mjs:195). */
export type NormalizedEvent =
  | { readonly kind: 'inbox'; readonly from: string; readonly to: string; readonly body: string; readonly sessionId: string; readonly ts: string }
  | { readonly kind: 'reply'; readonly from: string; readonly to: string | null; readonly body: string; readonly sessionId: string; readonly ts: string };

// --- Trust boundary: raw SSE envelope + the two consumed event types --------
// Shapes verified against bridge.mjs's actual parsing paths (bridge.mjs:146-205):
//   data: { type, data: { sessionID, item?: { type, payload?: { text } } } }   (inbox.enqueued)
//   data: { type, data: { sessionID, text } }                                   (text.ended)
const sseEnvelopeSchema = z.object({
  type: z.string(),
  data: z.unknown().optional(),
});
const inboxItemSchema = z.looseObject({
  type: z.string().optional(),
  payload: z.looseObject({ text: z.string().min(1) }).optional(),
});
const inboxDataSchema = z.looseObject({
  sessionID: z.string().min(1),
  item: inboxItemSchema.optional(),
});
const replyDataSchema = z.looseObject({
  sessionID: z.string().min(1),
  text: z.string().min(1),
});

/** Pure, unit-tested. Raw (already JSON-parsed) SSE event + session resolution
 *  → NormalizedEvent | null. Malformed/unknown raw shapes → null (no throw, no
 *  any — bridge.mjs:154-165 skip semantics). `ts` defaults to now (capture
 *  time ≈ bridge's save time, bridge.mjs:43); injectable for deterministic tests. */
export function normalizeServerEvent(
  raw: unknown,
  resolveSession: SessionResolver,
  ts: string = new Date().toISOString(),
): NormalizedEvent | null {
  const envelope = sseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;
  const { type, data } = envelope.data;

  if (type === 'session.inbox.enqueued') {
    const parsed = inboxDataSchema.safeParse(data);
    if (!parsed.success) return null;
    const item = parsed.data.item;
    // item.type === "user" → normalized human input (bridge.mjs:172-178 maps
    // only the SHAPE here; the wake-echo comparison and the boss-only filter
    // are the application's capture policy over the normalized event).
    if (item === undefined || item.type !== 'user') return null;
    const text = item.payload?.text;
    if (text === undefined) return null;
    const session = resolveSession(parsed.data.sessionID);
    if (!session) return null; // unknown/unresolvable session → no event (bridge.mjs:165)
    return { kind: 'inbox', from: 'human', to: session.name, body: text, sessionId: parsed.data.sessionID, ts };
  }

  if (type === 'session.text.ended') {
    const parsed = replyDataSchema.safeParse(data);
    if (!parsed.success) return null;
    const session = resolveSession(parsed.data.sessionID);
    if (!session) return null;
    return { kind: 'reply', from: session.name, to: null, body: parsed.data.text, sessionId: parsed.data.sessionID, ts };
  }

  return null; // event types the bridge never consumed
}

/** Incremental `data:`-line pump over the SSE body — port of bridge.mjs:146-159.
 *  Buffering across chunk boundaries, skip non-`data:` lines, skip unparseable
 *  JSON without crashing. Events are dispatched sequentially (awaited) to
 *  preserve the bridge's per-line ordering. Handler errors are the caller's
 *  responsibility here only for ASYNC rejection — sync throws propagate to the
 *  reconnect loop's catch (never kill the process; bridge logs and reconnects). */
export async function pumpSseStream(
  body: AsyncIterable<Uint8Array | string>,
  onRawEvent: (raw: unknown) => void | Promise<void>,
  onError: (err: unknown, raw: string) => void = () => {},
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice(5)); // bridge.mjs:156 — same slice point
      } catch {
        continue; // malformed line: skip, keep the stream alive
      }
      try {
        await onRawEvent(parsed);
      } catch (err) {
        onError(err, line);
      }
    }
  }
}

export interface OpenCodeEventStream {
  /** Subscribes the sink; reconnects automatically after a drop (bounded
   *  exponential backoff, capped at the bridge's 5 s — bridge.mjs:211). Handler
   *  errors never kill the stream; unresolvable/unknown sessions produce NO
   *  event. Returns an unsubscribe that aborts the in-flight stream and stops
   *  the reconnect loop. */
  subscribe(
    handler: (event: NormalizedEvent) => void | Promise<void>,
    resolveSession: SessionResolver,
  ): () => void;
}

export interface EventStreamOptions {
  /** Injected backoff delay for tests. Default: real setTimeout. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Backoff base (first reconnect wait). Default 1000 ms. */
  readonly baseDelayMs?: number;
  /** Backoff cap — the bridge reconnects at a flat 5 s (bridge.mjs:211);
   *  staying at ≤5 s keeps us no slower than the bridge. Default 5000 ms. */
  readonly maxDelayMs?: number;
}

export function createEventStream(
  client: OpenCodeHttpClient,
  opts: EventStreamOptions = {},
): OpenCodeEventStream {
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  return {
    subscribe(handler, resolveSession) {
      let stopped = false;
      const controller = new AbortController();
      let attempt = 0;

      void (async () => {
        // Yield once before the first connect: a synchronous unsubscribe()
        // right after subscribe() must cancel the initial connect.
        await Promise.resolve();
        while (!stopped) {
          try {
            const body = await client.stream('/api/event', { signal: controller.signal });
            attempt = 0; // successful connect → backoff resets
            await pumpSseStream(
              body,
              async (raw) => {
                // Handler errors must not kill the stream (work order §6).
                const event = normalizeServerEvent(raw, resolveSession);
                if (event) await handler(event);
              },
              (err) => console.error('[opencode] event handler failed', err),
            );
          } catch (err) {
            if (!stopped) console.error('[opencode] event stream dropped', err);
          }
          if (stopped) return;
          const ms = Math.min(baseDelayMs * 2 ** Math.min(attempt, 16), maxDelayMs);
          attempt += 1;
          await delay(ms);
        }
      })();

      return () => {
        stopped = true;
        controller.abort();
      };
    },
  };
}
