// Browser sessions: the store, the cookie helpers and the loopback predicates.
import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  SessionStore,
  clearSessionCookie,
  isLoopbackAddress,
  isLoopbackHost,
  readSessionId,
  sessionCookie,
} from '../src/api/middleware/session.js';

describe('SessionStore', () => {
  it('creates, reads and deletes a session', () => {
    const store = new SessionStore();
    const id = store.create({ name: 'human', kind: 'human' });
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(store.get(id)).toEqual({ name: 'human', kind: 'human' });
    store.delete(id);
    expect(store.get(id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('expires an entry and prunes it', () => {
    const store = new SessionStore();
    const id = store.create({ name: 'human', kind: 'human' }, 0);
    expect(store.get(id, 43_200_000 + 1)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('gives every browser its own id', () => {
    const store = new SessionStore();
    const a = store.create({ name: 'human', kind: 'human' });
    const b = store.create({ name: 'human', kind: 'human' });
    expect(a).not.toBe(b);
    store.delete(a);
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toEqual({ name: 'human', kind: 'human' });
  });
});

describe('cookie helpers', () => {
  it('parses this cookie out of a header and ignores others', () => {
    expect(readSessionId(`a=1; ${SESSION_COOKIE}=abc; b=2`)).toBe('abc');
    expect(readSessionId('a=1')).toBeNull();
    expect(readSessionId(undefined)).toBeNull();
  });

  it('emits the hardened cookie and its cleared twin', () => {
    const cookie = sessionCookie('abc');
    expect(cookie).toContain(`${SESSION_COOKIE}=abc`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=43200');
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});

describe('loopback predicates', () => {
  it('accepts every loopback form a socket can report', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('203.0.113.7')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('accepts loopback binds and refuses exposed ones', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });
});

describe('log redaction', () => {
  it('redacts both credential headers in the real list', async () => {
    const { LOG_REDACTION } = await import('../src/app.js');
    expect(LOG_REDACTION).toContain('req.headers.authorization');
    expect(LOG_REDACTION).toContain('req.headers.cookie');
  });
});
