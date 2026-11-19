// Config: safe defaults for a fresh clone, env overrides, gitignored auth
// file behavior (absent = open local access, malformed = loud error).
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/infrastructure/config/index.js';
import { tempDir } from './helpers.js';

describe('loadConfig', () => {
  it('defaults to host 127.0.0.1, port 3006, 1 MB body limit, open local access', () => {
    const cfg = loadConfig({ env: {}, authFile: join(tempDir(), 'absent.json'), peerAuthFile: join(tempDir(), 'absent-peer.json') });
    expect(cfg).toEqual({
      host: '127.0.0.1',
      port: 3006,
      bodyLimit: 1_048_576,
      dbPath: '.data/dev.db',
      opencodeTimeoutMs: 30_000,
      registryPath: 'config/agents.json',
      peerAllowlistPath: 'config/peer-to-peer-allowlist.json',
      projectsDir: './projects',
    });
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.opencodeServerUrl).toBeUndefined();
  });

  it('applies env overrides', () => {
    const cfg = loadConfig({
      env: {
        LOBBY_PORT: '4444',
        LOBBY_HOST: '0.0.0.0',
        LOBBY_BODY_LIMIT: '2048',
        LOBBY_DB_PATH: 'X:/tmp/lobby.db',
        LOBBY_OPENCODE_TIMEOUT_MS: '5000',
        LOBBY_OPENCODE_SERVER_URL: 'http://127.0.0.1:9999',
      },
      authFile: join(tempDir(), 'absent.json'), peerAuthFile: join(tempDir(), 'absent-peer.json'),
    });
    expect(cfg).toEqual({
      host: '0.0.0.0',
      port: 4444,
      bodyLimit: 2048,
      dbPath: 'X:/tmp/lobby.db',
      opencodeTimeoutMs: 5000,
      opencodeServerUrl: 'http://127.0.0.1:9999',
      registryPath: 'config/agents.json',
      peerAllowlistPath: 'config/peer-to-peer-allowlist.json',
      projectsDir: './projects',
    });
  });

  it('rejects an invalid OpenCode server URL', () => {
    expect(() => loadConfig({ env: { LOBBY_OPENCODE_SERVER_URL: 'not a url' }, authFile: join(tempDir(), 'absent.json'), peerAuthFile: join(tempDir(), 'absent-peer.json') }))
      .toThrow();
  });

  it('reads the bearer token from the gitignored auth file', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const authFile = join(dir, 'server.auth.json');
    writeFileSync(authFile, JSON.stringify({ authToken: 'secret123' }));
    const cfg = loadConfig({ env: {}, authFile });
    expect(cfg.authToken).toBe('secret123');
  });

  it('fails loud on a malformed auth file (operator meant to protect something)', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const authFile = join(dir, 'server.auth.json');
    writeFileSync(authFile, 'not json');
    expect(() => loadConfig({ env: {}, authFile })).toThrow(/malformed/);
  });

  it('fails loud on an empty-token auth file', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const authFile = join(dir, 'server.auth.json');
    writeFileSync(authFile, JSON.stringify({ authToken: '' }));
    expect(() => loadConfig({ env: {}, authFile })).toThrow(/malformed/);
  });

  it('fails loud on an existing but empty auth file (present file = operator intent, not open access)', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const authFile = join(dir, 'server.auth.json');
    writeFileSync(authFile, '');
    expect(() => loadConfig({ env: {}, authFile })).toThrow(/empty/);
  });

  it('fails loud on a whitespace-only auth file', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const authFile = join(dir, 'server.auth.json');
    writeFileSync(authFile, '  \n\t ');
    expect(() => loadConfig({ env: {}, authFile })).toThrow(/empty/);
  });

  it('keeps open access when the auth file is simply absent (decision 4)', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const cfg = loadConfig({ env: {}, authFile: join(dir, 'server.auth.json') });
    expect(cfg.authToken).toBeUndefined();
  });
});
