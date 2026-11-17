// OpenCode integration — HTTP/SSE client (integrations/opencode/client.ts).
//
// Ported from bridge.mjs: everything OpenCode-transport-specific lives here:
// effective server-URL DISCOVERY (bridge.mjs:22-34 — the local OpenCode server
// port changes on restart), HTTP Basic auth from the service registration file
// outside the repo (bridge.mjs:57-73, re-read per call), upstream request
// TIMEOUTS (decision 4), and error mapping to a single adapter error type.
//
// Nothing crossing OUT of integrations/opencode may carry OpenCode protocol
// knowledge; callers receive plain interfaces and this file's own error type.
// zod validates the config at the trust boundary (a caller may pass raw config
// straight from the composition root).
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const openCodeClientConfigSchema = z.object({
  /** Optional FALLBACK server URL from plain config (assessment §6 — the
   *  composition root may inject the configured `serverUrl` value; discovery
   *  of the EFFECTIVE URL stays inside the adapter). */
  fallbackServerUrl: z.url().nullable().default(null),
  /** Upstream request timeout in ms (decision 4). Applies to request/response
   *  calls; the long-lived SSE stream cannot carry a whole-request timeout —
   *  its drops are handled by the events module's reconnect loop. */
  timeoutMs: z.number().int().positive().default(30_000),
});

export interface OpenCodeClientOptions {
  /** Injectable discovery for tests. Default: `opencode service status`. */
  readonly discover?: () => string | null;
  /** Injectable service password reader for tests. Default: re-reads
   *  ~/.config/opencode/service.json per call (bridge.mjs:64-73). */
  readonly readServicePassword?: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}

/** The one error type the adapter throws for upstream failures. */
export class OpenCodeRequestError extends Error {
  readonly pathname: string;
  readonly status: number; // 0 = transport-level failure (network, timeout, discovery)
  readonly body: string;

  constructor(pathname: string, status: number, body: string, cause?: unknown) {
    super(`OpenCode ${pathname}: HTTP ${status} ${body}`, cause === undefined ? undefined : { cause });
    this.name = 'OpenCodeRequestError';
    this.pathname = pathname;
    this.status = status;
    this.body = body;
  }
}

export interface OpenCodeHttpClient {
  /** Effective server URL resolved once at creation (bridge discovers at
   *  startup, bridge.mjs:34); null when neither discovery nor fallback yields
   *  one — request()/stream() then fail loudly like the bridge's routes. */
  readonly serverUrl: string | null;
  /** JSON request/response call with auth + timeout; !ok → OpenCodeRequestError. */
  request(pathname: string, init?: RequestInit): Promise<unknown>;
  /** SSE stream: no timeout (long-lived by contract, bridge.mjs:141); auth
   *  headers attached; !ok or empty body → OpenCodeRequestError. Yields raw
   *  chunks for the events module's line parser. */
  stream(pathname: string, init?: RequestInit): Promise<AsyncIterable<Uint8Array | string>>;
}

export function createOpenCodeClient(
  configInput: unknown,
  opts: OpenCodeClientOptions = {},
): OpenCodeHttpClient {
  const config = openCodeClientConfigSchema.parse(configInput);
  const discover = opts.discover ?? defaultDiscoverServerUrl;
  const readServicePassword = opts.readServicePassword ?? defaultReadServicePassword;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Effective URL: discovered first-line http(s) URL wins, else the configured
  // fallback (bridge.mjs:22-34 — regex check happens here, inside the adapter).
  const discovered = discover();
  const serverUrl = discovered !== null && /^https?:\/\//.test(discovered)
    ? discovered
    : config.fallbackServerUrl;

  async function authorization(): Promise<string | null> {
    const password = await readServicePassword();
    return password
      ? 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
      : null;
  }

  async function headersWithAuth(extra?: RequestInit['headers']): Promise<Record<string, string>> {
    const authorization_ = await authorization();
    return {
      ...(authorization_ ? { authorization: authorization_ } : {}),
      // Callers pass plain header objects (the bridge does the same merge,
      // bridge.mjs:79); web-typed Headers instances are not a supported input.
      ...((extra as Record<string, string> | undefined) ?? {}),
    };
  }

  return {
    serverUrl,

    async request(pathname, init = {}) {
      if (!serverUrl) {
        throw new OpenCodeRequestError(pathname, 0, 'OpenCode server URL not discovered');
      }
      const headers = await headersWithAuth(init.headers);
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      // A caller-supplied signal (e.g. shutdown) combines with the timeout.
      const signal = init.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
      let res: Response;
      try {
        res = await fetchImpl(`${serverUrl}${pathname}`, { ...init, headers, signal });
      } catch (err) {
        throw new OpenCodeRequestError(pathname, 0, String(err), err);
      }
      if (!res.ok) {
        throw new OpenCodeRequestError(pathname, res.status, await res.text().catch(() => ''));
      }
      return res.json() as Promise<unknown>;
    },

    async stream(pathname, init = {}) {
      if (!serverUrl) {
        throw new OpenCodeRequestError(pathname, 0, 'OpenCode server URL not discovered');
      }
      const headers = await headersWithAuth(init.headers);
      let res: Response;
      try {
        res = await fetchImpl(`${serverUrl}${pathname}`, { ...init, headers });
      } catch (err) {
        throw new OpenCodeRequestError(pathname, 0, String(err), err);
      }
      if (!res.ok || !res.body) {
        const text = res.ok ? '' : await res.text().catch(() => '');
        throw new OpenCodeRequestError(pathname, res.status, text || 'empty SSE body');
      }
      // Node's fetch body is async-iterable; the DOM-typed ReadableStream does
      // not declare Symbol.asyncIterator in all type configurations.
      return res.body as AsyncIterable<Uint8Array>;
    },
  };
}

/** bridge.mjs:22-34 verbatim behavior: first stdout line of
 *  `opencode service status` when it looks like an http(s) URL, else null
 *  (the config fallback is applied by createOpenCodeClient, not here). */
export function defaultDiscoverServerUrl(): string | null {
  try {
    const out = spawnSync('opencode', ['service', 'status'], { encoding: 'utf8', shell: true });
    const url = (out.stdout || '').trim().split(/\r?\n/)[0] ?? '';
    if (/^https?:\/\//.test(url)) return url;
  } catch {
    // fall through
  }
  return null;
}

/** bridge.mjs:57-73: HTTP Basic credentials from the local service
 *  registration file (never stored in this repo); absent/unreadable → null
 *  (= no auth header, matching an open local server). Re-read per call so a
 *  service re-registration is picked up without a restart. */
async function defaultReadServicePassword(): Promise<string | null> {
  try {
    const raw = await readFile(join(homedir(), '.config', 'opencode', 'service.json'), 'utf8');
    const reg = JSON.parse(raw) as { password?: unknown };
    return typeof reg.password === 'string' && reg.password ? reg.password : null;
  } catch {
    return null;
  }
}
