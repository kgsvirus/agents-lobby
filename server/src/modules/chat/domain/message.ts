// Chat domain — message views and query types (modules/chat/domain).
//
// Pure domain logic only: no Fastify, no drizzle, no OpenCode knowledge.
// The wire shape ({ id, time, from, to, text }) is the legacy store.mjs:2,17
// alias; shared/schemas/wire.ts owns its zod schema and both the event bus and
// the HTTP layer consume it.
import type { WireMessage } from '../../../shared/schemas/wire.js';

export type WireMessageRow = WireMessage;

/** Sidebar views (store.mjs:65-79 / bridge.mjs:266-286): `all`, `boss`,
 *  `agent:<name>` (single-actor membership) and `project:<name>` (OR over the
 *  project's agents — the registry resolves the member names upstream). */
export type MessageView = 'all' | 'boss' | `agent:${string}` | `project:${string}`;

/** Directional pagination input (store.mjs:53): `before` wins over `after`
 *  (older-page), `after` is the catch-up cursor, plain = newest page. */
export interface MessageQuery {
  readonly view: string;
  readonly after: number;
  readonly before: number;
  readonly limit: number;
}

export interface MessagePage {
  readonly rows: readonly WireMessageRow[];
  readonly hasMore: boolean;
}

/** A new capture-point message before it has an id (store.mjs:41). The optional
 *  peer-messaging fields are omitted by capture paths: `messageId` is the
 *  client-supplied idempotency key of an explicit send, `captureSuppressed`
 *  arms the sender-turn suppressor, and `deliveryState` 0 marks a row whose
 *  prompt is not yet confirmed (1 = delivered/legacy, 2 = retried once). */
export interface NewMessage {
  readonly ts: string;
  readonly from: string;
  readonly to: string | null;
  readonly body: string;
  readonly sessionId: string | null;
  readonly messageId?: string | null;
  readonly captureSuppressed?: boolean;
  readonly deliveryState?: number;
}

/** The store's unread-slice filter. The boss wakes only for traffic addressed
 *  TO it:
 *  - its own replies never ride (`from === 'boss'`);
 *  - no human row rides (native when addressed to the boss, private when
 *    addressed to an agent), except a legacy null-receiver capture;
 *  - an agent row rides only when it names `boss` (or is a legacy null-receiver
 *    capture) - an agent's reply to the human is that agent's business.
 *  Pure, unit-tested. */
export function wakeSliceRows(rows: readonly WireMessageRow[]): WireMessageRow[] {
  return rows.filter((r) => {
    if (r.from === 'boss') return false;
    if (r.from === 'human') return r.to === null;
    if (r.to === null) return true; // legacy capture with no receiver
    return r.to.split(',').map((t) => t.trim()).includes('boss');
  });
}
