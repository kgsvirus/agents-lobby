// Phase 5 agents/projects mirror tests (decision 3: agents.json REMAINS the
// runtime registry; the db tables are the read-only mirror):
//   - startup sync (bridge reads agents.json once at startup, bridge.mjs:14-19)
//   - per-request re-read refresh (Phase 2 ruling; bridge.mjs:45-49,255-264)
//   - fresh clone (absent file) → empty mirror, server runs
//   - malformed/mixed-invalid entries → consistent with the Phase 4 reader's
//     all-or-nothing validation (loud 500, mirror keeps its previous state)
// No live server, no canonical db.
import Database from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { makeConfig, tempDir } from './helpers.js';
import { fakeOpenCode } from './chat-fakes.js';

// Two agents share the project 'Agents-Lobby' → the projects table derives
// DISTINCT projects in first-appearance order; the boss's own project appears
// via an agent too, proving derivation is over AGENT entries.
const REGISTRY = {
  serverUrl: 'http://localhost:4096',
  boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
  agents: [
    { name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow' },
    { name: 'lobby', project: 'Agents-Lobby', session: 'ses_lobby' },
    { name: 'immigapp', project: 'ImmigApp', session: 'ses_immigapp' },
  ],
};

interface Ctx {
  app: FastifyInstance;
  registryPath: string;
  dbPath: string;
  writeRegistry(content: unknown): void;
  removeRegistry(): void;
  mirror(): { agents: Row[]; projects: string[] };
}

interface Row {
  name: string;
  project: string;
  session: string;
  ordinal: number;
}

function setup(registry: unknown | undefined): Ctx {
  const dir = tempDir();
  const registryPath = join(dir, 'agents.json');
  if (registry !== undefined) writeFileSync(registryPath, JSON.stringify(registry));
  const opencode = fakeOpenCode();
  const env = { LOBBY_REGISTRY_PATH: registryPath };
  const dbPath = makeConfig(dir, env).dbPath;
  const app = buildApp(makeConfig(dir, env), { opencode: opencode.integration });
  // Mirror checks use a SEPARATE short-lived connection (the app owns its own).
  let raw: Database.Database | null = null;
  const sqlite = (): Database.Database => {
    if (raw === null) raw = new Database(dbPath);
    return raw;
  };
  return {
    app,
    registryPath,
    dbPath,
    writeRegistry(content: unknown) {
      writeFileSync(registryPath, JSON.stringify(content));
    },
    removeRegistry() {
      if (existsSync(registryPath)) unlinkSync(registryPath);
    },
    mirror() {
      return {
        agents: sqlite().prepare('SELECT name, project, session, ordinal FROM agents ORDER BY ordinal').all() as Row[],
        projects: (sqlite().prepare('SELECT name FROM projects').all() as Array<{ name: string }>).map((r) => r.name),
      };
    },
  };
}

describe('startup mirror sync (decision 3)', () => {
  it('seeds the agents + projects tables from agents.json at startup', async () => {
    const ctx = setup(REGISTRY);
    try {
      await ctx.app.ready();
      expect(ctx.mirror().agents).toEqual([
        { name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow', ordinal: 0 },
        { name: 'lobby', project: 'Agents-Lobby', session: 'ses_lobby', ordinal: 1 },
        { name: 'immigapp', project: 'ImmigApp', session: 'ses_immigapp', ordinal: 2 },
      ]);
      expect(ctx.mirror().projects).toEqual(['TaskFlow', 'Agents-Lobby', 'ImmigApp']);
    } finally {
      await ctx.app.close();
    }
  });

  it('absent agents.json (fresh clone) → empty mirror, server runs', async () => {
    const ctx = setup(undefined);
    try {
      await ctx.app.ready();
      expect(ctx.mirror()).toEqual({ agents: [], projects: [] });
    } finally {
      await ctx.app.close();
    }
  });

  it('a PRESENT-but-malformed registry at startup → app boots, mirror empty (per-request reads fail loud)', async () => {
    const dir = tempDir();
    const registryPath = join(dir, 'agents.json');
    writeFileSync(registryPath, '{ not json');
    const env = { LOBBY_REGISTRY_PATH: registryPath };
    const app = buildApp(makeConfig(dir, env), { opencode: fakeOpenCode().integration });
    try {
      await app.ready();
      const db = new Database(makeConfig(dir, env).dbPath);
      expect((db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
      db.close();
    } finally {
      await app.close();
    }
  });
});

describe('per-request re-read mirror refresh (Phase 2 ruling)', () => {
  it('a changed agents.json between requests is reflected in the mirror AND the response', async () => {
    const ctx = setup(REGISTRY);
    try {
      await ctx.app.ready();
      const before = await ctx.app.inject({ method: 'GET', url: '/api/agents' });
      expect(before.statusCode).toBe(200);
      expect(ctx.mirror().agents.map((r) => r.name)).toEqual(['taskflow', 'lobby', 'immigapp']);

      ctx.writeRegistry({
        ...REGISTRY,
        agents: [...REGISTRY.agents, { name: 'newagent', project: 'New', session: 'ses_newagent' }],
      });
      const after = await ctx.app.inject({ method: 'GET', url: '/api/agents' });
      expect(after.statusCode).toBe(200);
      // The RESPONSE body itself must reflect the change, in file order — a
      // stale/pre-re-read response fails this test.
      expect(after.json()).toEqual([
        { name: 'taskflow', project: 'TaskFlow' },
        { name: 'lobby', project: 'Agents-Lobby' },
        { name: 'immigapp', project: 'ImmigApp' },
        { name: 'newagent', project: 'New' },
      ]);
      expect(ctx.mirror().agents.map((r) => r.name)).toEqual([
        'taskflow',
        'lobby',
        'immigapp',
        'newagent',
      ]);
      expect(ctx.mirror().projects).toContain('New');
    } finally {
      await ctx.app.close();
    }
  });

  it('duplicate agent names: mirror sync succeeds and holds every entry, in file order', async () => {
    const ctx = setup({
      boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
      agents: [
        { name: 'twins', project: 'One', session: 'ses_t1' },
        { name: 'twins', project: 'Two', session: 'ses_t2' },
      ],
    });
    try {
      await ctx.app.ready();
      expect(ctx.mirror().agents).toEqual([
        { name: 'twins', project: 'One', session: 'ses_t1', ordinal: 0 },
        { name: 'twins', project: 'Two', session: 'ses_t2', ordinal: 1 },
      ]);
      expect(ctx.mirror().projects).toEqual(['One', 'Two']);
    } finally {
      await ctx.app.close();
    }
  });

  it('mixed-invalid entries: whole file rejected (consistent with the Phase 4 reader); mirror keeps its previous state', async () => {
    const ctx = setup(REGISTRY);
    try {
      await ctx.app.ready();
      const ok = await ctx.app.inject({ method: 'GET', url: '/api/agents' });
      expect(ok.statusCode).toBe(200);
      const before = ctx.mirror();

      ctx.writeRegistry({
        ...REGISTRY,
        agents: [{ name: 'good', project: 'P', session: 'ses_good' }, { name: 'bad', project: 'P' }],
      });
      const res = await ctx.app.inject({ method: 'GET', url: '/api/agents' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('registry_unavailable');
      expect(ctx.mirror()).toEqual(before); // all-or-nothing: nothing partially mirrored
    } finally {
      await ctx.app.close();
    }
  });
});
