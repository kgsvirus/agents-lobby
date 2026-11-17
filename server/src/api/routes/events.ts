// SSE endpoint GET /api/events — the single real-time channel (no WebSockets).
// Frame: `id: <events.id>`, `event: <type>`, `data: <payload JSON>`.
// Catch-up: `Last-Event-ID` header replays persisted events with id > cursor
// in id order (one shared sequence for all event types), then the connection
// continues live. Heartbeat comment every 25 s, matching today's bridge
// (bridge.mjs:313-317).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BusEvent } from '../../infrastructure/events/bus.js';
import type { WireMessage } from '../../shared/schemas/wire.js';

const HEARTBEAT_MS = 25_000;

const lastEventIdSchema = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer')
  // Digit-only accepts arbitrarily large strings and parseInt can then yield
  // unsafe or infinite numbers → 400, not an inaccurate query or a 500.
  .transform((value) => Number.parseInt(value, 10))
  .refine((n) => Number.isSafeInteger(n), 'exceeds the safe integer range');

export interface EventsRouteOptions {
  /**
   * Resolves message content for `message.created` frames from the `messages`
   * table (assessment §7: the event row is cursor/ordering only; the messages
   * table is the content source of truth). Returning null skips the frame.
   */
  readonly messageFor: (id: number) => WireMessage | null;
  /** Heartbeat interval in ms. Default: the production 25 s (bridge.mjs:313-317).
   *  Test-only injection point (the real-listener SSE harness makes fake timers
   *  impractical); production never sets it, so behavior is unchanged. */
  readonly heartbeatMs?: number;
}

export function eventsRoutes(app: FastifyInstance, opts: EventsRouteOptions): void {
  // Encapsulated scope (historical route structure; decision-4 scope: the
  // bearer token gates /send + /prompt ONLY, so /api/events stays OPEN even
  // when a token is configured — EventSource cannot send an Authorization
  // header, and a token-gated stream would break dashboard reconnects).
  app.register(async function eventsApi(scope) {
    scope.get('/api/events', async (request, reply) => {
      const bus = scope.bus;
      const raw = request.headers['last-event-id'];
      // Header arrives as string | string[] | undefined; the zod schema rejects
      // anything but a single non-negative integer → 400 via the global handler.
      // NO header = FRESH connection: it starts at the live head with NO
      // history replay (assessment §7 — catch-up is reconnect semantics; a
      // fresh page does its initial REST backfill from /api/messages). A
      // header = reconnect: replay everything after that cursor.
      const cursor = raw === undefined ? null : lastEventIdSchema.parse(raw);

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders(); // deliver headers immediately, before any frame
      const write = (chunk: string): void => {
        if (!res.writableEnded) res.write(chunk);
      };
      // Frame data: message.created content is resolved fresh from `messages`
      // by the id recorded in the event payload (never the stored event
      // payload — it is only a cursor/ordering record). A message row that is
      // gone → frame SKIPPED (chosen over a tombstone: no client of today's
      // dashboard can render a missing message, and skipping keeps the
      // cursor semantics simple); the event id still advances `lastSent`,
      // so cursor ordering is unaffected.
      const frame = (event: BusEvent): string | null => {
        if (event.type === 'message.created') {
          // BusEvent's payload union is not discriminated by `type`, but
          // publish/persist validated the payload per type — cast is sound.
          const message: WireMessage = event.payload as WireMessage;
          const data = opts.messageFor(message.id);
          if (data === null) return null;
          return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
        }
        return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
      };
      // Fresh-connection cursor checkpoint: a real SSE frame (comments cannot
      // carry an id field) whose only purpose is to seed the client's native
      // lastEventId buffer. Not a bus event — synthesized by this route.
      const checkpoint = (id: number): string =>
        `id: ${id}\nevent: lobby.checkpoint\ndata: {"head":${id}}\n\n`;
      // Subscribe BEFORE touching the cursor/head: events published while the
      // head read or replay query runs are buffered here, so no gap is
      // possible between the replayed tail and the live stream (single-process,
      // id-ordered).
      const pending: BusEvent[] = [];
      let live = false;
      let lastSent: number;
      const sendIfNew = (event: BusEvent): void => {
        if (event.id <= lastSent) return;
        const body = frame(event);
        lastSent = event.id;
        if (body !== null) write(body);
      };
      const unsubscribe = bus.subscribe((event) => {
        if (live) sendIfNew(event);
        else pending.push(event);
      });
      if (cursor === null) {
        // Live head read AFTER subscribe(): events buffered while this ran
        // (published between subscribe and head) carry id <= head and are
        // dropped by sendIfNew's guard — a fresh connection receives only
        // events published after it connected. No unbounded history replay.
        lastSent = bus.head();
        // Cursor checkpoint (typed no-op the client ignores): its id becomes
        // the connection's native lastEventId, so a disconnect BEFORE any
        // real event still auto-reconnects with Last-Event-ID and replays
        // exactly the gap (including agent.status_changed / project.updated,
        // which the REST backfill cannot recover). Without it, a header-less
        // reconnect would be misread as fresh and the gap would be lost.
        write(checkpoint(lastSent));
      } else {
        // Reconnect (Last-Event-ID): replay persisted events id > cursor.
        lastSent = cursor;
        for (const event of bus.replay(cursor)) sendIfNew(event);
      }
      live = true;
      for (const event of pending) sendIfNew(event);

      const heartbeat = setInterval(() => write(':hb\n\n'), opts.heartbeatMs ?? HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      res.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return reply;
    });
  });
}
