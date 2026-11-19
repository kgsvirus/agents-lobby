// Browser sessions for the dashboard (loopback auto-connect).
//
// A browser on this machine can act as the human principal without pasting a
// token. This is friction removal, not a security boundary: any process running
// as this OS user can read the token file anyway. See
// docs/superpowers/specs/2026-11-19-dashboard-auto-connect-design.md.
import { randomBytes } from 'node:crypto';
import type { Principal } from '../../infrastructure/config/index.js';

export const SESSION_COOKIE = 'lobby_session';
export const SESSION_MAX_AGE_SECONDS = 43_200;

interface Entry {
  readonly principal: Principal;
  readonly expiresAt: number;
}

export class SessionStore {
  readonly #sessions = new Map<string, Entry>();

  /** 256-bit server-generated id; the client never supplies one (no fixation). */
  create(principal: Principal, now: number = Date.now()): string {
    this.#prune(now);
    const id = randomBytes(32).toString('base64url');
    this.#sessions.set(id, { principal, expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000 });
    return id;
  }

  get(id: string, now: number = Date.now()): Principal | undefined {
    const entry = this.#sessions.get(id);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.#sessions.delete(id);
      return undefined;
    }
    return entry.principal;
  }

  delete(id: string): void {
    this.#sessions.delete(id);
  }

  size(): number {
    return this.#sessions.size;
  }

  #prune(now: number): void {
    for (const [id, entry] of this.#sessions) {
      if (entry.expiresAt <= now) this.#sessions.delete(id);
    }
  }
}

/** Reads this app's cookie out of a Cookie header. A base64url id contains no
 *  ';' or '=', so a plain split is sufficient. */
export function readSessionId(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Loopback peer addresses, including the dual-stack form a v6 socket reports. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** A bind we are willing to mint browser sessions for. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
