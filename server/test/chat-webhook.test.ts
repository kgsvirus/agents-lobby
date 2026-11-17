// POST /webhook — legacy capture path pins (bridge.mjs:342-363 semantics,
// retired on main in 809440a): field-by-field save semantics, the bridge's
// exact error texts inside the shared envelope, and the wake path invoked
// with the byte-identical wake prompt (same wake as the reply capture —
// reused from ChatService, not duplicated). No live OpenCode calls.
//
// The wake is fire-and-forget (bridge.mjs:357 does not await it), so tests do
// NOT sleep-and-hope: they poll for the wake's LAST observable action — the
// bookmark advance (bridge.mjs:124) or, on the skip path, the skip log
// (bridge.mjs:104) — before closing the app or asserting on it.
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { ChatMessageRepository } from '../src/modules/chat/infrastructure/message-repository.js';
import { WAKE_PROMPT } from '../src/integrations/opencode/prompts.js';
import { makeConfig, tempDir } from './helpers.js';
import { fakeOpenCode } from './chat-fakes.js';

interface Ctx {
  app: FastifyInstance;
  opencode: ReturnType<typeof fakeOpenCode>;
  dbPath: string;
  openDb(): Database.Database;
}

function setup(opts: { authToken?: boolean } = {}): Ctx {
  const dir = tempDir();
  const registryPath = join(dir, 'agents.json');
  const registry = {
    serverUrl: 'http://localhost:4096',
    boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
    agents: [{ name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow' }],
  };
  writeFileSync(registryPath, JSON.stringify(registry));
  const opencode = fakeOpenCode();
  const env: Record<string, string> = { LOBBY_REGISTRY_PATH: registryPath };
  const authFile = opts.authToken ? join(dir, 'server.auth.json') : join(dir, 'absent.auth.json');
  if (opts.authToken) writeFileSync(authFile, JSON.stringify({ authToken: 'secret123' }));
  const dbPath = makeConfig(dir, env, authFile).dbPath;
  const app = buildApp(makeConfig(dir, env, authFile), { opencode: opencode.integration });
  return {
    app,
    opencode,
    dbPath,
    openDb: () => new Database(dbPath), // separate short-lived handle; app owns its own
  };
}

/** Deterministic wait for the fire-and-forget wake: poll `probe` until it
 *  returns true (the wake's final observable state), with a deadline. */
async function until(probe: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function bookmarkId(db: Database.Database): number | null {
  const row = db.prepare('SELECT last_seen_id AS id FROM bookmarks WHERE consumer = ?').get('boss') as { id: number } | undefined;
  return row === undefined ? null : row.id;
}

describe('POST /webhook (bridge.mjs:342-363)', () => {
  it('valid payload → 200 {status:"ok"}; the row persists with the bridge field semantics (transcribed from bridge.mjs:350-355)', async () => {
    const ctx = setup();
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: 'greg', message: '  hi there  ' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });

      // Bridge save semantics (bridge.mjs:42-43,350-355): from || "unknown",
      // to: null, body trimmed, sessionId: null — the wire row must match.
      const expected = { from: 'greg', to: null, text: 'hi there' };

      const db = ctx.openDb();
      try {
        // Wait out the wake on its LAST state change (bookmark through the row)
        // so close() never races it and later assertions are stable.
        const messages = await ctx.app.inject({ method: 'GET', url: '/api/messages' });
        const row = messages.json().messages.at(-1);
        await until(() => bookmarkId(db) === row.id, 'the wake bookmark advance');

        // Field-by-field: receiver NULL, session_id NULL, body TRIMMED, sender
        // as given; ts is ISO-now (format + freshness), not a fixture value.
        expect(row).toEqual({ ...expected, id: row?.id, time: row.time });
        expect(row?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(Math.abs(Date.now() - new Date(row?.time ?? '').getTime())).toBeLessThan(5000);
        const raw = db.prepare('SELECT sender, receiver, body, session_id FROM messages ORDER BY id DESC LIMIT 1').get();
        expect(raw).toEqual({ sender: 'greg', receiver: null, body: 'hi there', session_id: null });
      } finally {
        db.close();
      }
    } finally {
      await ctx.app.close();
    }
  });

  it('from omitted (or empty) → sender "unknown"; from present → as given (bridge.mjs:351)', async () => {
    const ctx = setup();
    // Three concurrent fire-and-forget wakes can complete OUT OF ORDER, so the
    // completion signal is the per-wake final log line (bridge.mjs:126), not
    // any single bookmark value.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await ctx.app.ready();
      const omitted = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { message: 'no sender' } });
      expect(omitted.statusCode).toBe(200);
      const empty = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: '', message: 'also no sender' } });
      expect(empty.statusCode).toBe(200);
      const named = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: 'greg', message: 'named' } });
      expect(named.statusCode).toBe(200);
      await until(
        () => logSpy.mock.calls.filter((c) => c[0] === '[chat] Boss wake prompt enqueued.').length === 3,
        'all three wake prompts to enqueue',
      );

      const db = ctx.openDb();
      try {
        const senders = db.prepare('SELECT sender FROM messages ORDER BY id').all().map((r) => (r as { sender: string }).sender);
        expect(senders).toEqual(['unknown', 'unknown', 'greg']);
      } finally {
        db.close();
      }
    } finally {
      logSpy.mockRestore();
      await ctx.app.close();
    }
  });

  it('falsy/whitespace message → 400 "message is required" (bridge truthiness, :347-348); nothing saved, no wake', async () => {
    const ctx = setup();
    try {
      await ctx.app.ready();
      // bridge.mjs:347-348 — (message || "").trim(); !text → 400 "message is
      // required". A MISSING message key, '', null, 0 and false are ALL the
      // same falsy path; whitespace-only trims to ''.
      for (const payload of [
        { from: 'x' },
        { from: 'x', message: '   ' },
        { from: 'x', message: null },
        { from: 'x', message: 0 },
        { from: 'x', message: false },
      ]) {
        const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: payload as Record<string, unknown> });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        // Byte-equal message text per the standing envelope ruling (envelope
        // shape stays, text stays bridge-identical — task-5 ruling).
        expect(res.json()).toEqual({ error: { code: 'invalid_input', message: 'message is required' } });
      }
      const db = ctx.openDb();
      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
        expect(bookmarkId(db)).toBeNull(); // no wake ran
      } finally {
        db.close();
      }
      expect(ctx.opencode.promptCalls).toEqual([]);
    } finally {
      await ctx.app.close();
    }
  });

  it('truthy non-string message, and null / non-object bodies → the bridge blanket-catch 400 "Invalid JSON" (bridge.mjs:346-347,359-361)', async () => {
    const ctx = setup();
    try {
      await ctx.app.ready();
      // Truthy non-string message: (123 || "").trim() throws → catch :359-361.
      for (const payload of [{ from: 'x', message: 123 }, { from: 'x', message: { bad: true } }]) {
        const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: payload as Record<string, unknown> });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: { code: 'invalid_json', message: 'Invalid JSON' } });
      }
      // Destructuring semantics (bridge.mjs:346): a JSON null body throws →
      // "Invalid JSON"; a string/array body destructures to undefined props →
      // the falsy message path → "message is required".
      for (const [raw, expected] of [
        ['null', { error: { code: 'invalid_json', message: 'Invalid JSON' } }],
        ['"str"', { error: { code: 'invalid_input', message: 'message is required' } }],
        ['[1,2]', { error: { code: 'invalid_input', message: 'message is required' } }],
      ] as const) {
        const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: raw, headers: { 'content-type': 'application/json' } });
        expect(res.statusCode, raw).toBe(400);
        expect(res.json()).toEqual(expected);
      }
      const db = ctx.openDb();
      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
      expect(ctx.opencode.promptCalls).toEqual([]);
    } finally {
      await ctx.app.close();
    }
  });

  it('from truthiness (bridge.mjs:351): falsy → "unknown"; truthy number saved AS-IS via TEXT affinity ("123.0"); unbindable → blanket-catch 400', async () => {
    const ctx = setup();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: null, message: 'null sender' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      const numeric = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: 123, message: 'numeric sender' } });
      expect(numeric.statusCode).toBe(200);

      // Truthy non-string senders: SQLite TEXT affinity (legacy store.mjs
      // schema, deleted on main in 809440a) coerces the number 123 → '123.0'
      // — the value is passed through AS-IS by the repository, and the
      // column's TEXT affinity does the coercion (same for both drivers).

      // Values BOTH drivers reject binding (objects) → save failure → the
      // bridge's blanket catch (:350-361) → 400 "Invalid JSON", row not saved.
      const unbindable = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: { bad: true }, message: 'x' } });
      expect(unbindable.statusCode).toBe(400);
      expect(unbindable.json()).toEqual({ error: { code: 'invalid_json', message: 'Invalid JSON' } });
      expect(ctx.opencode.promptCalls).toEqual([]); // wake only after a successful save (bridge.mjs:350-357)

      const db = ctx.openDb();
      try {
        const rows = db.prepare('SELECT sender, body FROM messages ORDER BY id').all() as Array<{ sender: string; body: string }>;
        expect(rows).toEqual([
          { sender: 'unknown', body: 'null sender' },
          { sender: '123.0', body: 'numeric sender' }, // TEXT affinity coercion, as-is pass-through
        ]);
      } finally {
        db.close();
      }
      // Wait out BOTH fire-and-forget wakes on their per-wake final log
      // (bridge.mjs:126) so close() never races them.
      await until(
        () => logSpy.mock.calls.filter((c) => c[0] === '[chat] Boss wake prompt enqueued.').length === 2,
        'both wake prompts to enqueue',
      );
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      await ctx.app.close();
    }
  });

  it('a repository INSERT failure maps to the bridge blanket-catch response: 400 "Invalid JSON", nothing saved, no wake (bridge.mjs:350-361)', async () => {
    const ctx = setup();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await ctx.app.ready();
      // Inject the failure AT THE REPOSITORY (the real bridge-parity case:
      // store.insert throws INSIDE the transaction — bridge.mjs:350 → :359-361),
      // not merely at the transaction wrapper.
      const insertSpy = vi
        .spyOn(ChatMessageRepository.prototype, 'insert')
        .mockImplementation(() => {
          throw new Error('insert boom');
        });
      try {
        const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: 'greg', message: 'hi' } });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: { code: 'invalid_json', message: 'Invalid JSON' } });
      } finally {
        // Restore even when an assertion above fails — a leaked prototype spy
        // would break every later test in this file that hits the repository.
        insertSpy.mockRestore();
      }
      const db = ctx.openDb();
      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
      expect(ctx.opencode.promptCalls).toEqual([]); // bridge.mjs:357 — wake only after save
    } finally {
      errSpy.mockRestore();
      await ctx.app.close();
    }
  });

  it('invalid JSON → 400 with the bridge text, regardless of content type (bridge.mjs:343-346,359-361)', async () => {
    const ctx = setup();
    try {
      await ctx.app.ready();
      for (const headers of [{ 'content-type': 'application/json' }, {}]) {
        const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: 'nope{', headers });
        expect(res.statusCode).toBe(400);
        // bridge.mjs:360 — { error: "Invalid JSON" }; envelope keeps the text.
        expect(res.json()).toEqual({ error: { code: 'invalid_json', message: 'Invalid JSON' } });
      }
      expect(ctx.opencode.promptCalls).toEqual([]);
    } finally {
      await ctx.app.close();
    }
  });

  it('EMPTY body → 400 "Invalid JSON" with and without a content type (bridge.mjs:343-346,359-361)', async () => {
    const ctx = setup();
    try {
      await ctx.app.ready();
      // Bridge: zero chunks → body stays "" (:343-344); JSON.parse("") throws
      // (:346) → blanket catch → 400 "Invalid JSON" (:359-361).
      for (const headers of [{ 'content-type': 'application/json' }, {}]) {
        const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: '', headers });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: { code: 'invalid_json', message: 'Invalid JSON' } });
      }
      expect(ctx.opencode.promptCalls).toEqual([]);
    } finally {
      await ctx.app.close();
    }
  });

  it('wrong content type (text/plain) is ignored, exactly like the bridge: valid JSON saves, invalid JSON → 400 (bridge.mjs:342-346,359-361)', async () => {
    const ctx = setup();
    try {
      await ctx.app.ready();
      // The bridge never inspects Content-Type — it accumulates the raw bytes
      // (:343-344) and JSON.parses them (:346). Valid JSON under text/plain →
      // 200 + saved row; invalid JSON under text/plain → 400 "Invalid JSON".
      const ok = await ctx.app.inject({
        method: 'POST', url: '/webhook',
        payload: JSON.stringify({ from: 'greg', message: 'plain text type' }),
        headers: { 'content-type': 'text/plain' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ status: 'ok' });
      const bad = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: 'nope{', headers: { 'content-type': 'text/plain' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ error: { code: 'invalid_json', message: 'Invalid JSON' } });

      const db = ctx.openDb();
      try {
        const raw = db.prepare('SELECT sender, receiver, body, session_id FROM messages ORDER BY id DESC LIMIT 1').get();
        expect(raw).toEqual({ sender: 'greg', receiver: null, body: 'plain text type', session_id: null });
        // Wait out the fire-and-forget wake on its final state change
        // (bookmark through the row, bridge.mjs:124) before close.
        const row = db.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1').get() as { id: number };
        await until(() => bookmarkId(db) === row.id, 'the wake bookmark advance');
      } finally {
        db.close();
      }
    } finally {
      await ctx.app.close();
    }
  });

  it('valid POST wakes the boss with the byte-identical slice carrying the webhook row; bookmark moves through it', async () => {
    const ctx = setup();
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: 'greg', message: 'hi there' } });
      expect(res.statusCode).toBe(200);
      const messages = await ctx.app.inject({ method: 'GET', url: '/api/messages' });
      const row = messages.json().messages.at(-1);
      const db = ctx.openDb();
      try {
        await until(() => bookmarkId(db) === row.id, 'the wake bookmark advance');
        // Same wake flow as the reply capture (chat-service wakeBoss); the
        // slice line is the bridge's exact template (bridge.mjs:114-118) and a
        // NULL receiver renders as the literal "null" (formatWakeLine).
        expect(ctx.opencode.promptCalls).toEqual([
          { sessionId: 'ses_boss', text: `${WAKE_PROMPT}\n\n[${row.time}] [from: greg] [to: null] hi there` },
        ]);
        expect(bookmarkId(db)).toBe(row.id);
      } finally {
        db.close();
      }
    } finally {
      await ctx.app.close();
    }
  });

  it('wake coalescing: a pending user input skips the prompt entirely (bridge.mjs:102-106)', async () => {
    const ctx = setup();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await ctx.app.ready();
      ctx.opencode.pendingInput.set('ses_boss', true);
      const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { from: 'greg', message: 'hi' } });
      expect(res.statusCode).toBe(200);
      // The skip path's last observable action is the bridge's skip log
      // (bridge.mjs:104) — wait for it instead of sleeping.
      await until(
        () => logSpy.mock.calls.some((c) => c[0] === '[chat] Boss wake already pending, skipping.'),
        'the coalescing skip log',
      );
      expect(ctx.opencode.promptCalls).toEqual([]);
      const db = ctx.openDb();
      try {
        // …and the bookmark did not move: the row stays unread for the next wake.
        expect(bookmarkId(db)).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      logSpy.mockRestore();
      await ctx.app.close();
    }
  });

  it('the webhook is NOT gated by the optional bearer token (decision 4 gates /send + /prompt only)', async () => {
    const ctx = setup({ authToken: true });
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/webhook', payload: { message: 'open access' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      const db = ctx.openDb();
      try {
        await until(() => bookmarkId(db) !== null, 'the fire-and-forget wake completing');
      } finally {
        db.close();
      }
    } finally {
      await ctx.app.close();
    }
  });
});
