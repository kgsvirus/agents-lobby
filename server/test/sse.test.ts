// SSE endpoint tests: replay after Last-Event-ID, live continuation, header
// validation, optional bearer auth. Uses a real loopback server (ephemeral
// port) + fetch so frames can be read incrementally without a browser.
// Live events are published through the app's own bus (single-process by
// design — another connection's inserts are NOT visible to it).
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/client.js';
import type { WireMessage } from '../src/shared/schemas/wire.js';
import { makeConfig, sleep, tempDir, testDbPath } from './helpers.js';

function wire(id: number, text = `m${id}`): WireMessage {
  return { id, time: '2026-11-17T00:00:00Z', from: 'human', to: 'boss', text };
}

/** Insert the backing messages row for a message.created event (second connection). */
function insertMessage(dbFile: string, id: number, body = `m${id}`): void {
  const { sqlite } = openDatabase(dbFile);
  sqlite
    .prepare('INSERT INTO messages (id, ts, sender, receiver, body) VALUES (?, ?, ?, ?, ?)')
    .run(id, '2026-11-17T00:00:00Z', 'human', 'boss', body);
  sqlite.close();
}

async function startServer(dir: string, authFile?: string, options: BuildAppOptions = {}) {
  const app = buildApp(makeConfig(dir, {}, authFile), options);
  await app.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no listen address');
  return { app, url: `http://127.0.0.1:${address.port}/api/events` };
}

interface SseStream {
  readonly res: Response;
  until(pattern: string, timeoutMs?: number, minOccurrences?: number): Promise<string>;
  abort(): void;
}

async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseStream> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const body = res.body;
  if (body === null) throw new Error('no response body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    res,
    async until(pattern: string, timeoutMs = 5000, minOccurrences = 1): Promise<string> {
      const occurrences = (): number => buffer.split(pattern).length - 1;
      const deadline = Date.now() + timeoutMs;
      // One long-lived read across polls: issuing a fresh read per poll would
      // strand chunks delivered to an abandoned read — trickling frames (the
      // SSE heartbeat) were silently consumed and lost.
      let pending: ReturnType<typeof reader.read> | null = null;
      while (occurrences() < minOccurrences && Date.now() < deadline) {
        const chunk = await Promise.race([
          (pending ??= reader.read()),
          sleep(50).then(() => null),
        ]);
        if (chunk === null) continue; // poll tick — keep the same pending read
        pending = null;
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
        if (chunk.done) break;
      }
      if (occurrences() < minOccurrences) {
        throw new Error(`SSE stream did not contain ${JSON.stringify(pattern)} x${minOccurrences}; got: ${JSON.stringify(buffer)}`);
      }
      return buffer;
    },
    abort: () => controller.abort(),
  };
}

describe('GET /api/events (SSE)', () => {
  it('replays persisted events after Last-Event-ID in id order, then continues live', async () => {
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      insertMessage(testDbPath(dir), 1);
      insertMessage(testDbPath(dir), 2);
      app.bus.publish('message.created', wire(1));
      app.bus.publish('agent.status_changed', { name: 'dev', status: 'busy' });
      app.bus.publish('message.created', wire(2));

      const sse = await openSse(url, { 'last-event-id': '1' });
      expect(sse.res.status).toBe(200);
      expect(sse.res.headers.get('content-type')).toContain('text/event-stream');
      expect(sse.res.headers.get('cache-control')).toContain('no-cache');

      const buffer = await sse.until('id: 3\n');
      // id: 1 must NOT be replayed; the id: 2 frame must EXIST (and carry the
      // agent.status_changed event) — assert presence BEFORE order, since
      // indexOf(-1) < anything would silently pass; frames carry payload JSON.
      expect(buffer).not.toContain('id: 1\n');
      expect(buffer).toContain('id: 2\nevent: agent.status_changed');
      expect(buffer.indexOf('id: 2\n')).toBeLessThan(buffer.indexOf('id: 3\n'));
      expect(buffer).toContain(JSON.stringify({ name: 'dev', status: 'busy' }));

      insertMessage(testDbPath(dir), 3);
      app.bus.publish('message.created', wire(3));
      const live = await sse.until('id: 4');
      expect(live).toContain('event: message.created');
      expect(live).toContain(JSON.stringify(wire(3)));
      sse.abort();
    } finally {
      await app.close();
    }
  });

  it('without Last-Event-ID it streams live events (open local access, no token)', async () => {    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      const sse = await openSse(url);
      expect(sse.res.status).toBe(200);
      insertMessage(testDbPath(dir), 1);
      insertMessage(testDbPath(dir), 2);
      app.bus.publish('message.created', wire(1));
      app.bus.publish('message.created', wire(2));
      const buffer = await sse.until('id: 2');
      expect(buffer.indexOf('id: 1')).toBeLessThan(buffer.indexOf('id: 2'));
      expect(buffer).toContain('event: message.created');
      sse.abort();
    } finally {
      await app.close();
    }
  });

  it('a fresh connection (NO Last-Event-ID) gets NO history replay — live head start', async () => {
    // assessment §7: catch-up is reconnect semantics. Pre-existing events
    // (ids 1-2, with backing message rows) must NOT stream to a fresh page
    // (its REST backfill covers them); only post-connect events arrive.
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      insertMessage(testDbPath(dir), 1);
      insertMessage(testDbPath(dir), 2);
      app.bus.publish('message.created', wire(1));
      app.bus.publish('agent.status_changed', { name: 'dev', status: 'busy' });

      const sse = await openSse(url); // no Last-Event-ID header
      expect(sse.res.status).toBe(200);

      // Fresh connections get a typed cursor checkpoint seeding the native
      // lastEventId (disconnect-before-any-event still reconnects with a
      // cursor) — its id IS the live head, and it carries NO history.
      const cp = await sse.until('event: lobby.checkpoint');
      expect(cp).toContain('id: 2\nevent: lobby.checkpoint');
      expect(cp).toContain('"head":2}');

      insertMessage(testDbPath(dir), 3);
      app.bus.publish('message.created', wire(3));
      const buffer = await sse.until('id: 3\n');
      // Any replay-from-0 would have emitted the historical message.created
      // (id: 1) and agent.status_changed (id: 2) frames BEFORE id: 3 — the
      // until() buffer would carry them.
      expect(buffer).not.toContain('id: 1\n');
      expect(buffer).not.toContain('event: agent.status_changed'); // id 2 history NOT replayed
      expect(buffer).not.toContain('id: 2\nevent: agent.status_changed');
      expect(buffer).toContain('event: message.created');
      expect(buffer).toContain(JSON.stringify(wire(3)));
      sse.abort();
    } finally {
      await app.close();
    }
  });

  it('reconnect after an event-free initial connection replays the gap (checkpoint carries the cursor)', async () => {
    // The native EventSource buffers the last received id and re-sends it as
    // Last-Event-ID on auto-reconnect — even when NO real event ever arrived.
    // Simulated here: fresh connect (checkpoint id = 2), disconnect, events
    // published during the gap, reconnect WITH the checkpoint id as header.
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      insertMessage(testDbPath(dir), 1);
      app.bus.publish('message.created', wire(1)); // id 1
      app.bus.publish('agent.status_changed', { name: 'dev', status: 'busy' }); // id 2

      const first = await openSse(url);
      const cp = await first.until('event: lobby.checkpoint');
      expect(cp).toContain('id: 2\nevent: lobby.checkpoint'); // cursor seeded at the live head
      first.abort(); // disconnect before any real event

      // Gap: non-message events published while no client is connected.
      app.bus.publish('agent.status_changed', { name: 'dev', status: 'idle' }); // id 3
      app.bus.publish('project.updated', { name: 'TaskFlow' }); // id 4

      // Reconnect carrying the checkpoint id — exactly what a native
      // EventSource re-sends after the checkpoint frame.
      const second = await openSse(url, { 'last-event-id': '2' });
      const buffer = await second.until('id: 4\n');
      expect(buffer).toContain('event: agent.status_changed'); // gap event replayed
      expect(buffer).toContain(JSON.stringify({ name: 'dev', status: 'idle' }));
      expect(buffer).toContain('event: project.updated'); // gap event replayed
      expect(buffer).not.toContain('id: 1\n'); // NO pre-checkpoint history
      expect(buffer).not.toContain('id: 2\nevent: agent.status_changed'); // pre-checkpoint status NOT replayed
      second.abort();
    } finally {
      await app.close();
    }
  });

  it('delivers a transaction batch live in id order — no drops from lastSent advance', async () => {
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      insertMessage(testDbPath(dir), 1);
      const sse = await openSse(url);
      expect(sse.res.status).toBe(200);
      app.bus.transaction((persist) => {
        persist('message.created', wire(1)); // id 1
        persist('agent.status_changed', { name: 'dev', status: 'busy' }); // id 2
      });
      const buffer = await sse.until('id: 2');
      expect(buffer.indexOf('id: 1')).toBeLessThan(buffer.indexOf('id: 2'));
      expect(buffer).toContain('event: message.created');
      expect(buffer).toContain('event: agent.status_changed');
      sse.abort();
    } finally {
      await app.close();
    }
  });

  it('a reentrant publish during a transaction batch cannot make lastSent drop a batch event', async () => {
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      // Subscriber publishes id 3 synchronously while id 1 of the batch is
      // being delivered. Non-message event types, so frame presence is purely
      // an ordering question (message.created rows without backing messages
      // are skipped by design).
      app.bus.subscribe((event) => {
        if (event.id === 1) {
          app.bus.publish('agent.status_changed', { name: 'dev', status: 'nested' }); // id 3
        }
      });
      const sse = await openSse(url);
      app.bus.transaction((persist) => {
        persist('agent.status_changed', { name: 'dev', status: 'busy' }); // id 1
        persist('project.updated', { name: 'TaskFlow' }); // id 2
        return null;
      });
      const buffer = await sse.until('id: 3');
      // 2 must reach the client before the cursor lands at 3 — 1, 3, 2 would
      // drop event 2 from lastSent forever.
      expect(buffer.indexOf('id: 1')).toBeLessThan(buffer.indexOf('id: 2'));
      expect(buffer.indexOf('id: 2')).toBeLessThan(buffer.indexOf('id: 3'));
      sse.abort();
    } finally {
      await app.close();
    }
  });

  it('serves message.created content from the messages table, not the stored event payload', async () => {
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      // Fresh connection first (live head — no replay), then publish: the
      // frame's content is resolved fresh from the messages table either way.
      const sse = await openSse(url);
      expect(sse.res.status).toBe(200);
      insertMessage(testDbPath(dir), 1, 'fresh body');
      app.bus.publish('message.created', { ...wire(1), text: 'stale payload' });
      const buffer = await sse.until('fresh body');
      expect(buffer).toContain('event: message.created');
      expect(buffer).not.toContain('stale payload');
      sse.abort();
    } finally {
      await app.close();
    }
  });

  it('skips a message.created frame whose message row is gone; the cursor still advances', async () => {
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      insertMessage(testDbPath(dir), 1);
      app.bus.publish('message.created', wire(1));
      // Simulate a vanished message row: delete through a second connection.
      const { sqlite } = openDatabase(testDbPath(dir));
      sqlite.prepare('DELETE FROM messages WHERE id = 1').run();
      sqlite.close();
      app.bus.publish('agent.status_changed', { name: 'dev', status: 'busy' });

      const sse = await openSse(url, { 'last-event-id': '0' });
      const buffer = await sse.until('id: 2');
      expect(buffer).not.toContain('event: message.created'); // id: 1 frame skipped
      expect(buffer).not.toContain('id: 1\n');
      expect(buffer).toContain('event: agent.status_changed'); // id: 2 still delivered
      sse.abort();
    } finally {
      await app.close();
    }
  });

  it('sends heartbeat comments on an idle connection; they carry no id and do not advance the cursor', async () => {
    // The production 25 s heartbeat is untestable in real-listener time (the
    // SSE harness is a real loopback server + fetch, so fake timers would have
    // to drive the server's own interval through network delivery); the route
    // takes an injectable interval instead — the production default is
    // unchanged and no production caller sets it.
    const dir = tempDir();
    const { app, url } = await startServer(dir, undefined, { eventsHeartbeatMs: 100 });
    try {
      insertMessage(testDbPath(dir), 1);
      app.bus.publish('message.created', wire(1)); // id 1 — fresh connection starts at the live head
      const sse = await openSse(url);
      const cp = await sse.until('event: lobby.checkpoint');
      expect(cp).toContain('id: 1\nevent: lobby.checkpoint');

      // IDLE from here on: no events published after connect — the only
      // traffic is the heartbeat. Wait for three beats to prove the interval
      // fires repeatedly (not a one-shot write).
      const idle = await sse.until(':hb\n\n', 5000, 3);
      const afterCheckpoint = idle.slice(idle.indexOf('event: lobby.checkpoint'));
      expect(afterCheckpoint.split(':hb\n\n').length - 1).toBeGreaterThanOrEqual(3);
      // The heartbeat is a bare comment: it carries NO `id:` field (comments
      // cannot carry one — an id line would corrupt the client's native
      // lastEventId buffer), so it never touches the cursor — the ONLY id:
      // line in the idle buffer is the checkpoint's own.
      expect(afterCheckpoint).not.toContain('id: ');
      expect(afterCheckpoint).not.toContain('message.created'); // no history replay on idle

      // Cursor pin: a real event published AFTER heartbeats still streams with
      // its correct id — the heartbeat advanced `lastSent` by nothing (a
      // heartbeat-driven advance would make sendIfNew's `id <= lastSent` guard
      // drop this frame).
      insertMessage(testDbPath(dir), 2);
      app.bus.publish('message.created', wire(2));
      const live = await sse.until('id: 2\n');
      expect(live).toContain('event: message.created');
      expect(live).toContain(JSON.stringify(wire(2)));
      sse.abort();
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed Last-Event-ID header with the shared error envelope', async () => {
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      const res = await fetch(url, { headers: { 'last-event-id': 'not-a-number' } });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('validation_error');
    } finally {
      await app.close();
    }
  });

  it('rejects an oversized Last-Event-ID (unsafe integer) with the shared error envelope', async () => {
    const dir = tempDir();
    const { app, url } = await startServer(dir);
    try {
      // '9'.repeat(400) → parseInt yields Infinity; the 21-digit value parses
      // to a finite but unsafe number. Both must be 400, not a bad query/500.
      for (const huge of ['9'.repeat(400), '123456789012345678901']) {
        const res = await fetch(url, { headers: { 'last-event-id': huge } });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('validation_error');
      }
    } finally {
      await app.close();
    }
  });

  // Decision-4 scope (final-review ruling): the bearer token gates /send +
  // /prompt ONLY. /api/events must stay readable WITHOUT a token even when an
  // auth file is present — EventSource cannot send an Authorization header.
  it('stays open when a token is configured (auth scope is /send + /prompt only)', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const authFile = join(dir, 'server.auth.json');
    writeFileSync(authFile, JSON.stringify({ authToken: 'secret123' }));
    const { app, url } = await startServer(dir, authFile);
    try {
      const open = await fetch(url, { method: 'GET' });
      expect(open.status).toBe(200);

      const sse = await openSse(url);
      expect(sse.res.status).toBe(200);
      await sse.until('lobby.checkpoint'); // stream actually delivers, not just 200
      sse.abort();
    } finally {
      await app.close();
    }
  });
});
