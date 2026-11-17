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

/** A new capture-point message before it has an id (store.mjs:41). */
export interface NewMessage {
  readonly ts: string;
  readonly from: string;
  readonly to: string | null;
  readonly body: string;
  readonly sessionId: string | null;
}

/** The store's unread-slice filter (bridge.mjs:111-113): the boss already has
 *  its own replies (`from === 'boss'`) and the human's in-session prompts
 *  (`human → boss`) natively in its session — only everything else belongs in
 *  the wake slice. Pure, unit-tested. */
export function wakeSliceRows(rows: readonly WireMessageRow[]): WireMessageRow[] {
  return rows.filter((r) => r.from !== 'boss' && !(r.from === 'human' && r.to === 'boss'));
}
