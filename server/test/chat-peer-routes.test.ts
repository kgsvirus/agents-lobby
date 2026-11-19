// Peer messaging over HTTP: credential-derived identity, body-`from` mismatch,
// the identity endpoint, and legacy-mode compatibility.
//
// The underlying allowlist/persistence rules are pinned at the service level
// (chat-send-peer.test.ts); this file pins the HTTP identity contract.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { fakeOpenCode } from './chat-fakes.js';
import { makeConfig, tempDir } from './helpers.js';

const REGISTRY = {
  serverUrl: 'http://localhost:4096',
  boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
  agents: [
    { name: 'ruben', project: 'TaskFlow', session: 'ses_ruben' },
    { name: 'greg', project: 'TaskFlow', session: 'ses_greg' },
  ],
};

const PEER_AUTH = {
  talk: { name: 'ruben', kind: 'agent' },
  human: { name: 'human', kind: 'human' },
};

async function setupApp(peerAuth?: Record<string, { name: string; kind: string }>) {
  const dir = tempDir();
  const registryPath = `${dir}/agents.json`;
  writeFileSync(registryPath, JSON.stringify(REGISTRY));
  const peerAuthFile = `${dir}/peer-auth.json`;
  if (peerAuth !== undefined) writeFileSync(peerAuthFile, JSON.stringify({ tokens: peerAuth }));
  const config = makeConfig(dir, { LOBBY_REGISTRY_PATH: registryPath }, undefined, peerAuthFile);
  const opencode = fakeOpenCode();
  const app = buildApp(config, { opencode: opencode.integration });
  return { app, opencode, dir };
}

const H = (token: string) => ({ authorization: `Bearer ${token}` });

describe('peer messaging routes', () => {
  it('rejects /send without a token when identities are configured', async () => {
    const { app } = await setupApp(PEER_AUTH);
    try {
      await app.ready();
      const res = await app.inject({ method: 'POST', url: '/send', payload: { to: 'boss', message: 'x' } });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('a body `from` that contradicts the credential is 403 identity_mismatch', async () => {
    const { app } = await setupApp(PEER_AUTH);
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/send',
        headers: H('talk'),
        payload: { to: 'boss', message: 'x', from: 'boss' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('identity_mismatch');
    } finally {
      await app.close();
    }
  });

  it('serves the principal identity for a valid token and refuses an invalid one', async () => {
    const { app } = await setupApp(PEER_AUTH);
    try {
      await app.ready();
      const ok = await app.inject({ method: 'GET', url: '/api/principal', headers: H('human') });
      expect(ok.json()).toEqual({ name: 'human', kind: 'human' });
      const bad = await app.inject({ method: 'GET', url: '/api/principal', headers: H('nope') });
      expect(bad.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('an agent principal cannot drive the webchat /prompt', async () => {
    const { app } = await setupApp(PEER_AUTH);
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/prompt',
        headers: H('talk'),
        payload: { message: 'pretend to be human' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden_principal');
      const human = await app.inject({
        method: 'POST',
        url: '/prompt',
        headers: H('human'),
        payload: { message: 'hello' },
      });
      expect(human.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('legacy mode (no principal file) keeps the body `from` behavior and needs no token', async () => {
    const { app } = await setupApp();
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/send',
        payload: { to: 'ruben', message: 'hi', from: 'human' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sent: ['ruben'], skipped: [] });
      const principal = await app.inject({ method: 'GET', url: '/api/principal' });
      expect(principal.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
