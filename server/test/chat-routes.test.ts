// Chat presentation — HTTP shape tests via Fastify .inject(): /api/messages
// (three view forms + after/limit + 400 envelopes), /api/last-activity, /send
// + /prompt shapes and the optional bearer gate. Registry semantics are the
// bridge's: agents.json is RE-READ per request, so a file swap between
// requests is reflected immediately (fixture file swap), and an absent file is
// the documented graceful empty registry.
import Database from 'better-sqlite3';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../src/infrastructure/events/bus.js';
import { WAKE_PROMPT } from '../src/integrations/opencode/prompts.js';
import { makeConfig, tempDir } from './helpers.js';
import { fakeOpenCode } from './chat-fakes.js';

// The wake is async (registry re-read + IO) — wait for the condition instead
// of a fixed sleep, which flakes on slow filesystems (exFAT canonical).
async function until(probe: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Ctx {
  app: FastifyInstance;
  opencode: ReturnType<typeof fakeOpenCode>;
  registryPath: string;
  dbPath: string;
  writeRegistry(content: unknown): void;
  removeRegistry(): void;
  seedMessages(rows: Array<{ ts: string; from: string; to: string | null; body: string }>): void;
  bus: EventBus;
}

function setup(
  opts: { registry?: unknown; authToken?: boolean; peerAuth?: Record<string, { name: string; kind: string }> } = {},
): Ctx {
  const dir = tempDir();
  const registryPath = join(dir, 'agents.json');
  if (opts.registry !== undefined) {
    writeFileSync(registryPath, JSON.stringify(opts.registry));
  }
  const opencode = fakeOpenCode();
  const env: Record<string, string> = { LOBBY_REGISTRY_PATH: registryPath };
  const authFile = opts.authToken ? join(dir, 'server.auth.json') : join(dir, 'absent.auth.json');
  if (opts.authToken) writeFileSync(authFile, JSON.stringify({ authToken: 'secret123' }));
  const peerAuthFile = join(dir, 'peer-auth.json');
  if (opts.peerAuth) writeFileSync(peerAuthFile, JSON.stringify({ tokens: opts.peerAuth }));
  const config = makeConfig(dir, env, authFile, opts.peerAuth ? peerAuthFile : undefined);
  const dbPath = config.dbPath;
  const app = buildApp(config, { opencode: opencode.integration });
  // Seeding uses a SEPARATE short-lived connection to the same file (the app
  // owns its own); opened lazily so app.close() never races it.
  let raw: Database.Database | null = null;
  const sqlite = (): Database.Database => {
    if (raw === null) raw = new Database(dbPath);
    return raw;
  };
  return {
    app,
    opencode,
    registryPath,
    dbPath,
    writeRegistry(content: unknown) {
      writeFileSync(registryPath, JSON.stringify(content));
    },
    removeRegistry() {
      if (existsSync(registryPath)) unlinkSync(registryPath);
    },
    seedMessages(rows) {
      const seed = sqlite().prepare('INSERT INTO messages (ts, sender, receiver, body, session_id) VALUES (?, ?, ?, ?, ?)');
      for (const r of rows) seed.run(r.ts, r.from, r.to, r.body, null);
    },
    bus: app.bus,
  };
}

const REAL_REGISTRY = {
  serverUrl: 'http://localhost:4096',
  boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
  agents: [
    { name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow' },
    { name: 'immigapp', project: 'ImmigApp', session: 'ses_immigapp' },
  ],
};

describe('GET /api/messages', () => {
  it('returns the wire shape {messages, hasMore} for the view forms', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      ctx.seedMessages([
        { ts: '2026-11-17T10:00:00.000Z', from: 'boss', to: 'human', body: 'b1' },
        { ts: '2026-11-17T10:01:00.000Z', from: 'ruben', to: 'boss', body: 'r1' },
        { ts: '2026-11-17T10:02:00.000Z', from: 'human', to: 'taskflow, ruben', body: 't1' },
      ]);
      await ctx.app.ready();

      const all = await ctx.app.inject({ method: 'GET', url: '/api/messages' });
      expect(all.statusCode).toBe(200);
      expect(all.json()).toEqual({
        messages: [
          { id: 1, time: '2026-11-17T10:00:00.000Z', from: 'boss', to: 'human', text: 'b1' },
          { id: 2, time: '2026-11-17T10:01:00.000Z', from: 'ruben', to: 'boss', text: 'r1' },
          { id: 3, time: '2026-11-17T10:02:00.000Z', from: 'human', to: 'taskflow, ruben', text: 't1' },
        ],
        hasMore: false,
      });

      const boss = await ctx.app.inject({ method: 'GET', url: '/api/messages?view=boss' });
      expect(boss.json().messages.map((m: { id: number }) => m.id)).toEqual([1, 2]);

      const agent = await ctx.app.inject({ method: 'GET', url: '/api/messages?view=agent:ruben' });
      expect(agent.json().messages.map((m: { id: number }) => m.id)).toEqual([2, 3]);

      const project = await ctx.app.inject({ method: 'GET', url: '/api/messages?view=project:TaskFlow' });
      // The registry resolves TaskFlow's members = [taskflow]; ruben (the
      // sender of row 2) is not a TaskFlow agent in this fixture.
      expect(project.json().messages.map((m: { id: number }) => m.id)).toEqual([3]);
    } finally {
      await ctx.app.close();
    }
  });

  it('after/limit: catch-up direction, hasMore, and the bridge default limit of 10', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      for (let i = 1; i <= 12; i++) {
        ctx.seedMessages([{ ts: `2026-11-17T10:${String(i).padStart(2, '0')}:00.000Z`, from: 'boss', to: 'human', body: `m${i}` }]);
      }
      await ctx.app.ready();

      const page1 = await ctx.app.inject({ method: 'GET', url: '/api/messages' });
      expect(page1.json().messages.map((m: { id: number }) => m.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(page1.json().hasMore).toBe(true);

      const page2 = await ctx.app.inject({ method: 'GET', url: '/api/messages?before=3' });
      expect(page2.json().messages.map((m: { id: number }) => m.id)).toEqual([1, 2]);
      expect(page2.json().hasMore).toBe(false);

      const up = await ctx.app.inject({ method: 'GET', url: '/api/messages?after=10&limit=2' });
      expect(up.json().messages.map((m: { id: number }) => m.id)).toEqual([11, 12]);
      expect(up.json().hasMore).toBe(false);

      const more = await ctx.app.inject({ method: 'GET', url: '/api/messages?after=8&limit=2' });
      expect(more.json().messages.map((m: { id: number }) => m.id)).toEqual([9, 10]);
      expect(more.json().hasMore).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it('rejects invalid query input with the shared error envelope (400)', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      for (const url of ['/api/messages?limit=abc', '/api/messages?after=-1', '/api/messages?limit=-5', '/api/messages?after=1.5']) {
        const res = await ctx.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(400);
        expect(res.json().error.code).toBe('validation_error');
      }
    } finally {
      await ctx.app.close();
    }
  });
});

describe('GET /api/last-activity', () => {
  it('returns per-view stamps {all, boss, agent:<name>} → ts|null over the registry agents', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      ctx.seedMessages([
        { ts: '2026-11-17T10:00:00.000Z', from: 'boss', to: 'immigapp', body: 'wake' },
        { ts: '2026-11-17T10:01:00.000Z', from: 'taskflow', to: 'boss', body: 'ack' },
      ]);
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'GET', url: '/api/last-activity' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        all: '2026-11-17T10:01:00.000Z',
        boss: '2026-11-17T10:01:00.000Z',
        'agent:taskflow': '2026-11-17T10:01:00.000Z',
        'agent:immigapp': '2026-11-17T10:00:00.000Z', // receiver of the boss's 10:00 row
      });
    } finally {
      await ctx.app.close();
    }
  });

  // Registry names are z.string().min(1): an apostrophe (O'Reilly) is legal and
  // used to be string-interpolated into a SQL literal — breaking the query and,
  // with crafted names, altering it. Labels must be bound as parameters.
  it('registry names with apostrophes/quotes do not break /api/last-activity', async () => {
    const ctx = setup({
      registry: {
        serverUrl: 'http://localhost:9999',
        agents: [{ name: "O'Reilly", project: 'P', session: 'ses_o' }],
      },
    });
    try {
      ctx.seedMessages([{ ts: '2026-11-17T10:00:00.000Z', from: "O'Reilly", to: 'boss', body: 'hi' }]);
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'GET', url: '/api/last-activity' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        all: '2026-11-17T10:00:00.000Z',
        boss: '2026-11-17T10:00:00.000Z',
        "agent:O'Reilly": '2026-11-17T10:00:00.000Z',
      });
    } finally {
      await ctx.app.close();
    }
  });
});

describe('POST /send', () => {
  it('fans out and returns {sent, skipped} (200)', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'all', message: 'hi', from: 'human' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sent: ['taskflow', 'immigapp'], skipped: [] });
      expect(ctx.opencode.promptCalls).toEqual([
        { sessionId: 'ses_taskflow', text: 'Human: hi' },
        { sessionId: 'ses_immigapp', text: 'Human: hi' },
      ]);
      // The sent row is persisted (bridge.mjs:427-433) and visible via /api/messages.
      const messages = await ctx.app.inject({ method: 'GET', url: '/api/messages' });
      expect(messages.json().messages.at(-1)).toMatchObject({ from: 'human', to: 'taskflow, immigapp', text: 'hi' });
    } finally {
      await ctx.app.close();
    }
  });

  it('error shapes: 400 empty message, 400 bad sender, 404 no targets — shared envelope', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      const empty = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'all', message: '  ' } });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error).toMatchObject({ code: 'invalid_input', message: 'message is required' });

      const badSender = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'all', message: 'x', from: 'marvin' } });
      expect(badSender.statusCode).toBe(400);
      expect(badSender.json().error.code).toBe('invalid_sender');

      const noTargets = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'nobody', message: 'x' } });
      expect(noTargets.statusCode).toBe(404);
      expect(noTargets.json().error.code).toBe('no_targets');
    } finally {
      await ctx.app.close();
    }
  });

  it('EMPTY to array passes validation and resolves to the legacy 404 (finding 5, bridge.mjs:405-412)', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: [], message: 'x' } });
      // RULED (Phase 6): the shared ENVELOPE stays; the legacy MESSAGE TEXT
      // must stay byte-identical to the bridge (`no matching agents for: ` +
      // JSON.stringify(to)) — pinned here exactly, envelope shape included.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'no_targets', message: 'no matching agents for: []' } });
      expect(ctx.opencode.promptCalls).toEqual([]);
    } finally {
      await ctx.app.close();
    }
  });

  it('no effective server URL → fail-fast 500 with the bridge message (finding 3, bridge.mjs:399-400)', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      ctx.opencode.available = false;
      const res = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'all', message: 'x' } });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatchObject({
        code: 'upstream_unavailable',
        message: 'OpenCode server URL not discovered',
      });
      expect(ctx.opencode.promptCalls).toEqual([]); // failed fast, nothing attempted
    } finally {
      await ctx.app.close();
    }
  });

  it('RE-READS agents.json per request: a registry file swap is reflected immediately', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      const before = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'newagent', message: 'x' } });
      expect(before.statusCode).toBe(404); // not registered yet

      ctx.writeRegistry({
        ...REAL_REGISTRY,
        agents: [...REAL_REGISTRY.agents, { name: 'newagent', project: 'New', session: 'ses_newagent' }],
      });
      const after = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'newagent', message: 'x' } });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({ sent: ['newagent'], skipped: [] });
    } finally {
      await ctx.app.close();
    }
  });

  it('absent agents.json (fresh clone): graceful empty registry → 404; last-activity nulls', async () => {
    const ctx = setup();
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'all', message: 'x' } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('no_targets');
      const acts = await ctx.app.inject({ method: 'GET', url: '/api/last-activity' });
      expect(acts.json()).toEqual({ all: null, boss: null });
    } finally {
      await ctx.app.close();
    }
  });
});

describe('POST /prompt', () => {
  it('prompts the boss session and returns {status: "ok"} (200)', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/prompt', payload: { message: 'wake up' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(ctx.opencode.promptCalls).toEqual([{ sessionId: 'ses_boss', text: 'wake up' }]);
    } finally {
      await ctx.app.close();
    }
  });

  it('400 on empty message; 500 envelope when the boss session is not configured', async () => {
    const ctx = setup({ registry: { ...REAL_REGISTRY, boss: undefined } });
    try {
      await ctx.app.ready();
      const empty = await ctx.app.inject({ method: 'POST', url: '/prompt', payload: { message: '' } });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error.code).toBe('invalid_input');

      const noBoss = await ctx.app.inject({ method: 'POST', url: '/prompt', payload: { message: 'x' } });
      expect(noBoss.statusCode).toBe(500);
      expect(noBoss.json().error.code).toBe('registry_unavailable');
    } finally {
      await ctx.app.close();
    }
  });

  it('no effective server URL → fail-fast 500 with the bridge message, checked BEFORE the registry (bridge.mjs:372-373)', async () => {
    const ctx = setup({ registry: { ...REAL_REGISTRY, boss: undefined } });
    try {
      await ctx.app.ready();
      ctx.opencode.available = false;
      const res = await ctx.app.inject({ method: 'POST', url: '/prompt', payload: { message: 'x' } });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatchObject({
        code: 'upstream_unavailable',
        message: 'OpenCode server URL not discovered',
      });
    } finally {
      await ctx.app.close();
    }
  });
});

describe('optional bearer auth (decision 4) — /send + /prompt only', () => {
  it('gates /send and /prompt when a token is configured; reads stay open', async () => {
    const ctx = setup({ registry: REAL_REGISTRY, authToken: true });
    try {
      await ctx.app.ready();
      for (const url of ['/send', '/prompt']) {
        const denied = await ctx.app.inject({ method: 'POST', url, payload: { message: 'x', to: 'all' } });
        expect(denied.statusCode).toBe(401);
        expect(denied.json().error.code).toBe('unauthorized');
      }
      const wrong = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'all', message: 'x' }, headers: { authorization: 'Bearer wrong' } });
      expect(wrong.statusCode).toBe(401);
      // Reads are NOT gated (decision-4 scope: /send + /prompt only).
      const reads = await ctx.app.inject({ method: 'GET', url: '/api/messages' });
      expect(reads.statusCode).toBe(200);
      const agents = await ctx.app.inject({ method: 'GET', url: '/api/agents' });
      expect(agents.statusCode).toBe(200);
      const ok = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'all', message: 'x' }, headers: { authorization: 'Bearer secret123' } });
      expect(ok.statusCode).toBe(200);
      const okPrompt = await ctx.app.inject({ method: 'POST', url: '/prompt', payload: { message: 'x' }, headers: { authorization: 'Bearer secret123' } });
      expect(okPrompt.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });

  it('absent token file = open local access (no 401 anywhere)', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      const res = await ctx.app.inject({ method: 'POST', url: '/send', payload: { to: 'all', message: 'x' } });
      expect(res.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });
});

describe('chat sink wiring through the composition root', () => {
  it('an agent reply delivered through the sink triggers the coalesced boss wake', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      await ctx.opencode.deliver({
        kind: 'reply', from: 'taskflow', to: null, body: 'phase done', sessionId: 'ses_taskflow', ts: '2026-11-17T10:00:00.000Z',
      });
      await until(() => ctx.opencode.promptCalls.length === 1, 'the coalesced boss wake');
      expect(ctx.opencode.promptCalls).toHaveLength(1);
      expect(ctx.opencode.promptCalls[0]?.sessionId).toBe('ses_boss');
      // Slice carries the reply; byte-identical format.
      expect(ctx.opencode.promptCalls[0]?.text).toBe(
        WAKE_PROMPT + '\n\n[2026-11-17T10:00:00.000Z] [from: taskflow] [to: boss] phase done',
      );
    } finally {
      await ctx.app.close();
    }
  });

  it('the session resolver registered by the composition root maps sessions like the bridge', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      expect(ctx.opencode.resolveSession('ses_boss')).toEqual({ name: 'boss', role: 'boss' });
      expect(ctx.opencode.resolveSession('ses_taskflow')).toEqual({ name: 'taskflow', role: 'agent' });
      expect(ctx.opencode.resolveSession('ses_unknown')).toBeNull();
    } finally {
      await ctx.app.close();
    }
  });

  it('SSE: a chat-ingested message publishes message.created and the row persists', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      const busEvents: Array<{ id: number; type: string; payload: unknown }> = [];
      ctx.bus.subscribe((e) => busEvents.push({ id: e.id, type: e.type, payload: e.payload }));
      await ctx.opencode.deliver({
        kind: 'inbox', from: 'human', to: 'boss', body: 'via sink', sessionId: 'ses_boss', ts: '2026-11-17T10:00:00.000Z',
      });
      expect(busEvents).toHaveLength(1);
      expect(busEvents[0]).toMatchObject({ type: 'message.created', payload: { from: 'human', to: 'boss', text: 'via sink' } });
      // The persisted row resolves from messages (the SSE frame content source).
      const messages = await ctx.app.inject({ method: 'GET', url: '/api/messages?view=boss' });
      expect(messages.json().messages).toHaveLength(1);
    } finally {
      await ctx.app.close();
    }
  });

  it('ingest failures REJECT into the adapter sink (finding 1: no voided promise → no unhandled rejection)', async () => {
    const ctx = setup({ registry: REAL_REGISTRY });
    try {
      await ctx.app.ready();
      // Make ingest fail: the sink callback must propagate the rejection so
      // the adapter's pumpSseStream catch logs it and the stream continues —
      // a `void` here would swallow it into an unhandled rejection instead.
      const chat = ctx.app.chat;
      const original = chat.handleEvent.bind(chat);
      chat.handleEvent = async () => {
        throw new Error('ingest boom');
      };
      await expect(ctx.opencode.deliver({
        kind: 'inbox', from: 'human', to: 'boss', body: 'x', sessionId: 'ses_boss', ts: '2026-11-17T10:00:00.000Z',
      })).rejects.toThrow('ingest boom');
      chat.handleEvent = original;
      // The catch-and-log step lives in the adapter (pumpSseStream → onError)
      // and is pinned by test/opencode-stream.test.ts ("survives handler
      // errors without dropping the connection"); this test pins the wiring
      // half: the sink callback returns the promise instead of voiding it.
    } finally {
      await ctx.app.close();
    }
  });
});
