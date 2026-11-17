// OpenCode session port + resolver tests (bridge.mjs:102-106, 160-165 ports).
// Upstream inbox responses are faked — no live server.
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeRequestError, type OpenCodeHttpClient } from '../src/integrations/opencode/client.js';
import { createSessionPort, createSessionResolver } from '../src/integrations/opencode/sessions.js';
function clientReturning(payload: unknown, capture?: (pathname: string) => void): OpenCodeHttpClient {
  return {
    serverUrl: 'http://test',
    request: vi.fn(async (pathname: string) => {
      capture?.(pathname);
      if (payload instanceof Error) throw payload;
      return payload;
    }),
    stream: vi.fn(async () => { throw new Error('not used'); }),
  };
}

describe('hasPendingUserInput (bridge.mjs:102-106 port)', () => {
  it('returns true when any inbox item is a user item', async () => {
    let pathname = '';
    const port = createSessionPort(clientReturning(
      { data: [{ type: 'message', role: 'user' }, { type: 'user', payload: { text: 'x' } }] },
      (p) => { pathname = p; },
    ));
    expect(await port.hasPendingUserInput('ses_boss')).toBe(true);
    expect(pathname).toBe('/api/session/ses_boss/inbox');
  });

  it('returns false for non-user items and empty inboxes', async () => {
    const port = createSessionPort(clientReturning({ data: [{ type: 'message' }] }));
    expect(await port.hasPendingUserInput('ses_boss')).toBe(false);
    expect(await createSessionPort(clientReturning({ data: [] })).hasPendingUserInput('ses_boss')).toBe(false);
  });

  it('propagates upstream failures as the NEUTRAL PortError (rich details logged inside, never thrown)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const port = createSessionPort(clientReturning(new OpenCodeRequestError('/inbox', 500, 'secret-body')));
    await expect(port.hasPendingUserInput('ses_boss')).rejects.toMatchObject({
      name: 'PortError',
      code: 'upstream-error',
    });
    // The neutral rejection must not carry the rich internal error's details.
    await expect(port.hasPendingUserInput('ses_boss')).rejects.toSatisfy((err: unknown) => {
      const e = err as Error;
      return !e.message.includes('/inbox') && !e.message.includes('secret-body') && !('cause' in e);
    });
    expect(errSpy).toHaveBeenCalled(); // rich details logged inside the adapter
    errSpy.mockRestore();
  });

  it('throws the neutral PortError (code invalid-response) on malformed inbox payloads (trust boundary — never silently "no pending")', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createSessionPort(clientReturning({ nope: true })).hasPendingUserInput('s')).rejects.toMatchObject({ name: 'PortError', code: 'invalid-response' });
    await expect(createSessionPort(clientReturning({ data: 'not-an-array' })).hasPendingUserInput('s')).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(createSessionPort(clientReturning({ data: [{ type: 7 }] })).hasPendingUserInput('s')).rejects.toMatchObject({ code: 'invalid-response' });
    errSpy.mockRestore();
  });
});

describe('createSessionResolver (bridge.mjs:160-165 port)', () => {
  const registry = {
    serverUrl: 'http://irrelevant',
    boss: { name: 'Boss', project: 'lobby', session: 'ses_boss' },
    agents: [
      { name: 'devx', project: 'p1', session: 'ses_dev' },
      { name: 'qa', project: 'p1', session: 'ses_qa' },
    ],
  };

  it('resolves the boss session to the fixed domain name "boss" (bridge.mjs:162,187)', () => {
    expect(createSessionResolver(() => registry)('ses_boss')).toEqual({ name: 'boss', role: 'boss' });
  });

  it('resolves agent sessions to their registry name', () => {
    expect(createSessionResolver(() => registry)('ses_dev')).toEqual({ name: 'devx', role: 'agent' });
    expect(createSessionResolver(() => registry)('ses_qa')).toEqual({ name: 'qa', role: 'agent' });
  });

  it('returns null for unknown sessions, invalid registries, and loader failures', () => {
    expect(createSessionResolver(() => registry)('ses_other')).toBeNull();
    expect(createSessionResolver(() => ({ boss: {}, agents: 'no' }))('ses_boss')).toBeNull();
    expect(createSessionResolver(() => { throw new Error('file gone'); })('ses_boss')).toBeNull();
  });

  it('boss wins when an agent entry carries the boss session id (bridge checks isBoss first)', () => {
    const shadowed = { boss: { session: 'ses_boss' }, agents: [{ name: 'imposter', session: 'ses_boss' }] };
    expect(createSessionResolver(() => shadowed)('ses_boss')).toEqual({ name: 'boss', role: 'boss' });
  });
});
