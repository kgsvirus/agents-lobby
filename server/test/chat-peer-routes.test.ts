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

const ALLOWLIST = {
  human: ['boss', 'coordinator'],
  boss: ['human', 'coordinator'],
  coordinator: ['human', 'boss'],
};

/** Identity mode by default; `authToken` switches to shared-token mode, and
 *  omitting `peerAuth` gives open mode. The allowlist is a TEMP file so the
 *  suite never depends on this machine's gitignored policy. */
async function setupApp(
  opts: {
    peerAuth?: Record<string, { name: string; kind: string }>;
    authToken?: string;
    host?: string;
  } = { peerAuth: PEER_AUTH },
) {
  const dir = tempDir();
  const registryPath = `${dir}/agents.json`;
  writeFileSync(registryPath, JSON.stringify(REGISTRY));
  const allowlistPath = `${dir}/allowlist.json`;
  writeFileSync(allowlistPath, JSON.stringify(ALLOWLIST));
  const peerAuthFile = `${dir}/peer-auth.json`;
  if (opts.peerAuth !== undefined) writeFileSync(peerAuthFile, JSON.stringify({ tokens: opts.peerAuth }));
  const authFile = `${dir}/server.auth.json`;
  if (opts.authToken !== undefined) writeFileSync(authFile, JSON.stringify({ authToken: opts.authToken }));
  const env: Record<string, string> = {
    LOBBY_REGISTRY_PATH: registryPath,
    LOBBY_PEER_ALLOWLIST_PATH: allowlistPath,
  };
  if (opts.host !== undefined) env.LOBBY_HOST = opts.host;
  const config = makeConfig(dir, env, authFile, peerAuthFile);
  const opencode = fakeOpenCode();
  const app = buildApp(config, { opencode: opencode.integration });
  return { app, opencode, dir };
}

const H = (token: string) => ({ authorization: `Bearer ${token}` });

/** The connect/disconnect routes require this header (an HTML form cannot send
 *  custom headers, which is what keeps a cross-site page from minting). */
const CONNECT = { 'x-lobby-connect': '1' };

/** The session id out of a Set-Cookie header, for the next request. */
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return value.split(';')[0] as string;
}

describe('peer messaging routes', () => {
  it('rejects /send without a token when identities are configured', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const res = await app.inject({ method: 'POST', url: '/send', payload: { to: 'boss', message: 'x' } });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('a body `from` that contradicts the credential is 403 identity_mismatch', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
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
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
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
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
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
    const { app } = await setupApp({});
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

describe('browser auto-connect (identity mode)', () => {
  it('mints a hardened cookie and authenticates with it', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const mode = await app.inject({ method: 'GET', url: '/api/auth-mode' });
      expect(mode.json()).toEqual({ mode: 'identity' });

      const connect = await app.inject({ method: 'POST', url: '/api/connect', headers: CONNECT });
      expect(connect.statusCode).toBe(200);
      expect(connect.json()).toEqual({ name: 'human', kind: 'human' });
      const cookie = cookieFrom(connect);
      expect(cookie.startsWith('lobby_session=')).toBe(true);
      expect(String(connect.headers['set-cookie'])).toContain('HttpOnly');

      const who = await app.inject({ method: 'GET', url: '/api/principal', headers: { cookie } });
      expect(who.statusCode).toBe(200);
      expect(who.json()).toEqual({ name: 'human', kind: 'human' });

      const send = await app.inject({
        method: 'POST',
        url: '/send',
        headers: { cookie },
        payload: { to: 'boss', message: 'from the browser' },
      });
      expect(send.statusCode).toBe(200);
      const rows = await app.inject({ method: 'GET', url: '/api/messages?view=all' });
      expect(rows.json().messages.at(-1)).toMatchObject({ from: 'human', to: 'boss' });
    } finally {
      await app.close();
    }
  });

  it('a cookie can never claim another identity', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const cookie = cookieFrom(await app.inject({ method: 'POST', url: '/api/connect', headers: CONNECT }));
      const spoof = await app.inject({
        method: 'POST',
        url: '/send',
        headers: { cookie },
        payload: { to: 'boss', message: 'x', from: 'boss' },
      });
      expect(spoof.statusCode).toBe(403);
      expect(spoof.json().error.code).toBe('identity_mismatch');
    } finally {
      await app.close();
    }
  });

  it('an invalid Authorization header never falls back to the cookie', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const cookie = cookieFrom(await app.inject({ method: 'POST', url: '/api/connect', headers: CONNECT }));
      const res = await app.inject({
        method: 'POST',
        url: '/send',
        headers: { cookie, authorization: 'Bearer revoked' },
        payload: { to: 'boss', message: 'x' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('a valid token still wins over a cookie', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const cookie = cookieFrom(await app.inject({ method: 'POST', url: '/api/connect', headers: CONNECT }));
      const res = await app.inject({
        method: 'POST',
        url: '/send',
        headers: { cookie, ...H('human') },
        payload: { to: 'boss', message: 'token path' },
      });
      expect(res.statusCode).toBe(200);
      const who = await app.inject({ method: 'GET', url: '/api/principal', headers: { cookie, ...H('talk') } });
      expect(who.json()).toEqual({ name: 'ruben', kind: 'agent' });
    } finally {
      await app.close();
    }
  });

  it('disconnect clears the session; the old cookie is rejected at /send', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const cookie = cookieFrom(await app.inject({ method: 'POST', url: '/api/connect', headers: CONNECT }));
      const bye = await app.inject({ method: 'POST', url: '/api/disconnect', headers: { cookie, ...CONNECT } });
      expect(bye.statusCode).toBe(200);
      expect(String(bye.headers['set-cookie'])).toContain('Max-Age=0');
      const after = await app.inject({
        method: 'POST',
        url: '/send',
        headers: { cookie },
        payload: { to: 'boss', message: 'x' },
      });
      expect(after.statusCode).toBe(401);
      const idempotent = await app.inject({ method: 'POST', url: '/api/disconnect', headers: CONNECT });
      expect(idempotent.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('two browsers get independent sessions', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const a = cookieFrom(await app.inject({ method: 'POST', url: '/api/connect', headers: CONNECT }));
      const b = cookieFrom(await app.inject({ method: 'POST', url: '/api/connect', headers: CONNECT }));
      expect(a).not.toBe(b);
      await app.inject({ method: 'POST', url: '/api/disconnect', headers: { cookie: a, ...CONNECT } });
      const stillB = await app.inject({ method: 'GET', url: '/api/principal', headers: { cookie: b } });
      expect(stillB.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('refuses to mint behind a proxy (any proxy header present)', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/api/connect',
        remoteAddress: '127.0.0.1',
        headers: { ...CONNECT, 'x-forwarded-for': '203.0.113.7' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('proxied');
      expect(res.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('refuses a non-loopback caller', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/api/connect',
        remoteAddress: '203.0.113.7',
        headers: CONNECT,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_loopback');
      expect(res.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('refuses without the connect header (cross-site form guard)', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const res = await app.inject({ method: 'POST', url: '/api/connect' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('connect_header_required');
    } finally {
      await app.close();
    }
  });

  it('refuses a non-loopback Host name (DNS rebinding)', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/api/connect',
        headers: { ...CONNECT, host: 'evil.example:3005' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('bad_host');
    } finally {
      await app.close();
    }
  });

  it('refuses a non-loopback bind', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH, host: '0.0.0.0' });
    try {
      await app.ready();
      const res = await app.inject({ method: 'POST', url: '/api/connect', headers: CONNECT });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_loopback');
    } finally {
      await app.close();
    }
  });

  it('refuses connect outside identity mode, naming the mode', async () => {
    const open = await setupApp({});
    try {
      await open.app.ready();
      expect((await open.app.inject({ method: 'GET', url: '/api/auth-mode' })).json()).toEqual({ mode: 'open' });
      const res = await open.app.inject({ method: 'POST', url: '/api/connect' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('auth_mode_open');
    } finally {
      await open.app.close();
    }

    const shared = await setupApp({ authToken: 'shared-secret' });
    try {
      await shared.app.ready();
      expect((await shared.app.inject({ method: 'GET', url: '/api/auth-mode' })).json()).toEqual({
        mode: 'shared-token',
      });
      const res = await shared.app.inject({ method: 'POST', url: '/api/connect' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('auth_mode_shared_token');
    } finally {
      await shared.app.close();
    }
  });
});

describe('credential mode endpoints', () => {
  it('shared-token mode answers /api/principal as the human with a valid token', async () => {
    const { app } = await setupApp({ authToken: 'shared-secret' });
    try {
      await app.ready();
      const ok = await app.inject({
        method: 'GET',
        url: '/api/principal',
        headers: H('shared-secret'),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ name: 'human', kind: 'human' });
      const bad = await app.inject({ method: 'GET', url: '/api/principal', headers: H('nope') });
      expect(bad.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('identity mode refuses connect before the loopback check when a proxy header is present', async () => {
    const { app } = await setupApp({ peerAuth: PEER_AUTH });
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/api/connect',
        headers: { ...CONNECT, forwarded: 'for=203.0.113.7' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('proxied');
    } finally {
      await app.close();
    }
  });
});
