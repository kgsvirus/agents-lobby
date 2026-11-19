// Principal identities for the send endpoints (peer messaging).
//
// `requirePrincipal` maps a bearer token to a principal and sets
// `request.principal`; `/api/principal` lets the dashboard verify a pasted
// token without sending a message. With no principal file the whole feature is
// absent (legacy body-`from` mode), so nothing here is registered.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/api/plugins/error-handler.js';
import { requirePrincipal, tokenToPrincipal } from '../src/api/middleware/peer-auth.js';
import { loadConfig, type Principal } from '../src/infrastructure/config/index.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'lobby-peer-auth-'));

function peerAuthFile(content: unknown): string {
  const file = join(dir(), 'peer-auth.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

async function appWith(file?: string) {
  const config = loadConfig({ env: { LOBBY_DB_PATH: join(dir(), 'x.db') }, authFile: join(dir(), 'absent.json'), peerAuthFile: file });
  const app = Fastify();
  registerErrorHandler(app);
  if (config.peerAuth !== undefined) {
    const principals = config.peerAuth;
    app.get('/api/principal', { preHandler: requirePrincipal(principals) }, async (request) => request.principal);
    app.post('/guarded', { preHandler: requirePrincipal(principals) }, async () => ({ ok: true }));
  }
  await app.ready();
  return app;
}

const TOKENS = { tokens: { talk: { name: 'ruben', kind: 'agent' }, human: { name: 'human', kind: 'human' } } };

describe('principal resolution', () => {
  it('maps a token to its principal', () => {
    const principals = new Map<string, Principal>([['talk', { name: 'ruben', kind: 'agent' }]]);
    expect(tokenToPrincipal(principals, 'Bearer talk')).toEqual({ name: 'ruben', kind: 'agent' });
    expect(tokenToPrincipal(principals, 'Bearer nope')).toBeUndefined();
    expect(tokenToPrincipal(principals, undefined)).toBeUndefined();
    expect(tokenToPrincipal(principals, 'Basic talk')).toBeUndefined();
  });

  it('guards a route and serves the identity endpoint', async () => {
    const app = await appWith(peerAuthFile(TOKENS));
    try {
      const denied = await app.inject({ method: 'POST', url: '/guarded' });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error).toMatchObject({ code: 'unauthorized', message: 'Missing or invalid bearer token' });
      expect(denied.headers['www-authenticate']).toContain('Bearer');

      const wrong = await app.inject({ method: 'POST', url: '/guarded', headers: { authorization: 'Bearer wrong' } });
      expect(wrong.statusCode).toBe(401);

      const ok = await app.inject({ method: 'POST', url: '/guarded', headers: { authorization: 'Bearer talk' } });
      expect(ok.statusCode).toBe(200);

      const who = await app.inject({ method: 'GET', url: '/api/principal', headers: { authorization: 'Bearer human' } });
      expect(who.json()).toEqual({ name: 'human', kind: 'human' });
    } finally {
      await app.close();
    }
  });

  it('an absent principal file leaves the feature off (legacy mode)', async () => {
    const app = await appWith(join(dir(), 'missing.json'));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/principal' });
      expect(res.statusCode).toBe(404);
      const post = await app.inject({ method: 'POST', url: '/guarded' });
      expect(post.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a malformed or empty principal file fails loudly at config load', () => {
    expect(() => loadConfig({ authFile: join(dir(), 'absent.json'), peerAuthFile: peerAuthFile('{ nope') })).toThrow(/not valid JSON/);
    expect(() => loadConfig({ authFile: join(dir(), 'absent.json'), peerAuthFile: peerAuthFile('  ') })).toThrow(/empty/);
    expect(() =>
      loadConfig({ authFile: join(dir(), 'absent.json'), peerAuthFile: peerAuthFile({ tokens: { a: { name: 'x', kind: 'robot' } } }) }),
    ).toThrow(/malformed/);
  });
});
