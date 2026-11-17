// Composition-root wiring test (Phase 4 review finding 2): the agents.json
// serverUrl fallback must reach the adapter's startup config, with documented
// precedence — discovery (inside the adapter) > LOBBY_OPENCODE_SERVER_URL env >
// agents.json serverUrl (bridge.mjs:31). The real factory is mocked so no
// discovery spawn and no live server is involved; the captured config is the
// assertion surface.
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const captured: Array<Record<string, unknown>> = [];
// Hoisted mock factory (vitest hoists vi.mock above imports): records the
// config createOpenCodeIntegration receives, returns a minimal inert
// integration so buildApp's wiring runs without I/O.
vi.mock('../src/integrations/opencode/index.js', () => ({
  createOpenCodeIntegration: (config: Record<string, unknown>) => {
    captured.push(config);
    return {
      events: { subscribe: () => () => {} },
      sessions: { hasPendingUserInput: async () => false },
      prompts: { isAvailable: () => true, prompt: async () => {} },
    };
  },
  // Entry-surface split point app.ts wires for the event sink (never invoked
  // here — subscribe is inert; it only must exist because the real app.ts
  // evaluates the resolver factory at wiring time).
  createSessionResolver: () => () => null,
}));

import { buildApp } from '../src/app.js';
import { registryFallbackServerUrl } from '../src/infrastructure/registry/reader.js';
import { makeConfig, tempDir } from './helpers.js';

const cleaned: string[] = [];
afterEach(() => {
  for (const dir of cleaned) {
    const f = join(dir, 'agents.json');
    if (existsSync(f)) unlinkSync(f);
  }
  cleaned.length = 0;
});

async function buildWith(dir: string, registryPath: string, env: Record<string, string>): Promise<unknown> {
  captured.length = 0;
  const app = buildApp(makeConfig(dir, { LOBBY_REGISTRY_PATH: registryPath, ...env }));
  try {
    return captured[0]?.fallbackServerUrl;
  } finally {
    await app.close();
  }
}

describe('adapter startup config — agents.json serverUrl fallback (finding 2)', () => {
  it('uses the registry serverUrl when the env override is absent (bridge fallback restored)', async () => {
    const dir = tempDir();
    cleaned.push(dir);
    const registryPath = join(dir, 'agents.json');
    writeFileSync(registryPath, JSON.stringify({
      serverUrl: 'http://from-registry:4096',
      boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
      agents: [],
    }));
    expect(await buildWith(dir, registryPath, {})).toBe('http://from-registry:4096');
  });

  it('the explicit env override wins over the registry serverUrl (documented precedence)', async () => {
    const dir = tempDir();
    cleaned.push(dir);
    const registryPath = join(dir, 'agents.json');
    writeFileSync(registryPath, JSON.stringify({
      serverUrl: 'http://from-registry:4096',
      boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
      agents: [],
    }));
    expect(await buildWith(dir, registryPath, { LOBBY_OPENCODE_SERVER_URL: 'http://from-env:9999' })).toBe(
      'http://from-env:9999',
    );
  });

  it('no env + a non-URL registry value → null fallback; absent registry → null fallback', async () => {
    const dir = tempDir();
    cleaned.push(dir);
    const registryPath = join(dir, 'agents.json');
    writeFileSync(registryPath, JSON.stringify({ serverUrl: 'not a url', boss: null, agents: [] }));
    expect(await buildWith(dir, registryPath, {})).toBeNull();
    unlinkSync(registryPath); // absent file: graceful, no fallback
    expect(await buildWith(dir, registryPath, {})).toBeNull();
  });

  it('a PREFIX-valid but INVALID URL ("http://") does not stop startup: ignored, logged, fallback null (finding 1)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = tempDir();
      cleaned.push(dir);
      const registryPath = join(dir, 'agents.json');
      // "http://" passes a naive prefix check but fails the adapter's z.url()
      // config parse — it must be treated as absent, not break startup.
      writeFileSync(registryPath, JSON.stringify({
        serverUrl: 'http://',
        boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
        agents: [],
      }));
      expect(await buildWith(dir, registryPath, {})).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ignoring invalid agents.json serverUrl'),
      );
      // A valid value alongside the invalid precedent still applies.
      writeFileSync(registryPath, JSON.stringify({
        serverUrl: 'http://valid-fallback:4096',
        boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
        agents: [],
      }));
      expect(await buildWith(dir, registryPath, {})).toBe('http://valid-fallback:4096');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('the helper itself rejects every malformed shape (unit, same z.url() bar as the adapter config)', () => {
    expect(registryFallbackServerUrl(null)).toBeNull();
    expect(registryFallbackServerUrl({})).toBeNull();
    expect(registryFallbackServerUrl({ serverUrl: '' })).toBeNull();
    expect(registryFallbackServerUrl({ serverUrl: 'http://' })).toBeNull();
    expect(registryFallbackServerUrl({ serverUrl: 'https://localhost:4096/x' })).toBe('https://localhost:4096/x');
  });
});
