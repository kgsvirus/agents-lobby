// GET /api/agents — HTTP shape equivalence against bridge.mjs:255-264:
//   json(200, (await loadRegistry()).agents.map(({ name, project }) => ({
//     name, project,
//   })));
// i.e. a 200 JSON array of {name, project} ONLY (no session, no boss), in
// agents.json FILE order. The bridge's loadRegistry re-reads the file per
// request (bridge.mjs:45-49) — mirrored by the per-request re-read + db mirror
// query. No live server; the expected value is computed from the SAME fixture
// file with the bridge's literal mapping expression.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { makeConfig, tempDir } from './helpers.js';
import { fakeOpenCode } from './chat-fakes.js';
const REGISTRY = {
  serverUrl: 'http://localhost:4096',
  boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
  agents: [
    { name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow' },
    { name: 'lobby', project: 'Agents-Lobby', session: 'ses_lobby' },
    { name: 'immigapp', project: 'ImmigApp', session: 'ses_immigapp' },
  ],
};

function setup(registry: unknown | undefined) {
  const dir = tempDir();
  const registryPath = join(dir, 'agents.json');
  if (registry !== undefined) writeFileSync(registryPath, JSON.stringify(registry));
  const app = buildApp(makeConfig(dir, { LOBBY_REGISTRY_PATH: registryPath }), {
    opencode: fakeOpenCode().integration,
  });
  return { app, registryPath };
}

/** bridge.mjs:258-262 — the literal mapping the bridge serves, over the SAME
 *  fixture file the app reads (loadRegistry = JSON.parse of the file). */
function bridgeAgents(registryPath: string): Array<{ name: string; project: string }> {
  return (JSON.parse(readFileSync(registryPath, 'utf8')) as typeof REGISTRY).agents.map(
    ({ name, project }) => ({ name, project }),
  );
}

describe('GET /api/agents', () => {
  it('200 {name, project}[] — deep-equal to the bridge mapping over the same file (order included)', async () => {
    const ctx = setup(REGISTRY);
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/agents' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toEqual(bridgeAgents(ctx.registryPath));
      // Exactly the wire keys — session and the boss entry never cross.
      for (const entry of res.json() as Array<Record<string, unknown>>) {
        expect(Object.keys(entry).sort()).toEqual(['name', 'project']);
      }
    } finally {
      await ctx.app.close();
    }
  });

  it('absent agents.json (fresh clone) → 200 [] (documented graceful default; the bridge would exit)', async () => {
    const ctx = setup(undefined);
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/agents' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await ctx.app.close();
    }
  });

  it('query strings → 404, bridge parity (bridge.mjs:255 exact-matches req.url; catch-all 404 "not found", bridge.mjs:445) — the shared envelope keeps the bridge\'s message text byte-identical', async () => {
    const ctx = setup(REGISTRY);
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/agents?x=1' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'not found' } });
    } finally {
      await ctx.app.close();
    }
  });

  it('duplicate agent names are preserved: both entries served, in file order (bridge.mjs:258 maps the whole array)', async () => {
    const ctx = setup({
      boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
      agents: [
        { name: 'twins', project: 'One', session: 'ses_t1' },
        { name: 'twins', project: 'Two', session: 'ses_t2' },
      ],
    });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/agents' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { name: 'twins', project: 'One' },
        { name: 'twins', project: 'Two' },
      ]);
    } finally {
      await ctx.app.close();
    }
  });
});
