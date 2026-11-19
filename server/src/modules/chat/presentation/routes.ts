// Chat presentation — thin Fastify routes (modules/chat/presentation).
//
// Validation (zod) + the shared error envelope only; every handler delegates
// to the ChatService application layer — zero business logic here. The
// optional bearer auth applies to /send + /prompt ONLY (decision 4: absent
// token file = open local access, matching today's bridge).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChatService } from '../application/chat-service.js';
import { parseMessageQuery } from '../domain/query.js';
import { AppError } from '../../../shared/errors/index.js';
import type { FastifyRequest } from 'fastify';
import { bearerCheck } from '../../../api/middleware/auth.js';
import { requireCredential } from '../../../api/middleware/peer-auth.js';
import {
  clearSessionCookie,
  isLoopbackAddress,
  isLoopbackHost,
  readSessionId,
  sessionCookie,
  type SessionStore,
} from '../../../api/middleware/session.js';
import type { Principal } from '../../../infrastructure/config/index.js';

// `from` is validated in the SERVICE (business rule, bridge.mjs:397-398) so
// the error envelope carries the bridge's exact message and code. An EMPTY
// `to` array passes validation (bridge.mjs:405-412 accepts `to: []`) and
// resolves to the legacy no-targets 404 in the service.
const sendBodySchema = z.object({
  to: z.union([z.string().min(1), z.array(z.string().min(1))]),
  message: z.string(),
  from: z.string().optional(), // default 'boss' — bridge.mjs:394
  // Peer sends: client idempotency key (see ChatService).
  messageId: z.string().min(1).optional(),
});

const promptBodySchema = z.object({
  message: z.string(),
});

// bridge.mjs:346 — the parsed body is DESTRUCTURED (`const { from, message }
// = JSON.parse(body)`), so its shape is whatever JSON.parse produced: only
// `null` is special (destructuring throws → the bridge's blanket catch
// :359-361); every other JSON shape (object, array, string, number, boolean)
// yields undefined props and follows the truthiness path. RULING (fix round
// 2): zod must not reject ANY payload the bridge accepts — it validates the
// body is defined JSON here (z.unknown() accepts all of it), and the
// truthiness rules ARE the validation, in the service (bridge.mjs:347-351).
const webhookBodySchema = z.unknown();

// Query params: numeric cursors are coerced and REJECTED at the boundary
// (zod, decision 4) — garbage/negative/fractional input → 400 envelope, a
// documented tightening of the bridge's silent NaN→0 fallback (the dashboard
// only ever sends well-formed numbers). Valid inputs keep the bridge's exact
// arithmetic via domain/query.ts ('' → 0, limit ''/0 → 10).
const messagesQuerySchema = z.object({
  view: z.string().max(200).optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().nonnegative().optional(),
});

export interface ChatRoutesOptions {
  readonly service: ChatService;
  /** Undefined = open local access (decision 4). Applies to /send + /prompt. */
  readonly authToken?: string;
  /** Token -> principal map (peer messaging). Undefined = the feature is off:
   *  no identity endpoint, and /send keeps the legacy body-`from` mode. */
  readonly principals?: ReadonlyMap<string, Principal>;
  /** Browser sessions (loopback auto-connect). REQUIRED alongside `principals`;
   *  an identity server without it would have to fail open. */
  readonly sessions?: SessionStore;
  /** The bind address. Required for identity mode; an absent value refuses to
   *  mint browser sessions rather than assuming loopback. */
  readonly host?: string;
}

/** Which credential mode this server runs in. */
export type AuthMode = 'identity' | 'shared-token' | 'open';

/** Proxy/tunnel headers: their presence means a reverse proxy sits in front of
 *  the lobby, so the peer address is the proxy's, not the browser's, and
 *  minting a human session would grant it to whoever the proxy serves. */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'] as const;

export function chatRoutes(app: FastifyInstance, opts: ChatRoutesOptions): void {
  const service = opts.service;
  const principals = opts.principals;
  const sessions = opts.sessions;
  const mode: AuthMode =
    principals !== undefined ? 'identity' : opts.authToken !== undefined ? 'shared-token' : 'open';
  if (principals !== undefined && sessions === undefined) {
    // Refuse to build instead of failing open on /send.
    throw new Error('chatRoutes: sessions are required when principals are configured');
  }
  const identity = principals !== undefined && sessions !== undefined ? { principals, sessions } : undefined;
  const peerGuard = identity === undefined ? undefined : requireCredential(identity.principals, identity.sessions);
  const sendAuth =
    mode === 'identity'
      ? peerGuard
      : mode === 'shared-token'
        ? bearerCheck(opts.authToken as string)
        : undefined;

  app.get('/api/auth-mode', async () => ({ mode }));

  // Identity check for the dashboard: no message is sent. In identity mode it
  // proves the cookie/token; in shared-token mode the shared token IS the human
  // credential, so it answers as the human (the UI offers a paste there).
  if (mode === 'identity') {
    app.get('/api/principal', { preHandler: peerGuard }, async (request) => request.principal);
  } else if (mode === 'shared-token') {
    app.get('/api/principal', { preHandler: sendAuth }, async () => ({ name: 'human', kind: 'human' }));
  }

  if (identity !== undefined) {
    /** Shared refusal checks for both browser-session routes. */
    const browserOnly = (request: FastifyRequest): void => {
      if (PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) {
        throw new AppError(403, 'proxied', 'browser sessions are not minted behind a proxy or tunnel');
      }
      if (request.headers['x-lobby-connect'] !== '1') {
        // A header a plain HTML form cannot send: together with the JSON
        // content type this is what stops a cross-site form from connecting
        // or disconnecting the visitor.
        throw new AppError(403, 'connect_header_required', 'this endpoint requires the x-lobby-connect header');
      }
      const host = opts.host;
      if (host === undefined || !isLoopbackHost(host)) {
        throw new AppError(403, 'not_loopback', 'browser sessions are only minted for a loopback bind');
      }
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        throw new AppError(403, 'not_loopback', 'browser sessions are only minted for loopback callers');
      }
      const hostHeader = request.headers.host;
      // Strip the port and compare the hostname: this is the DNS-rebinding
      // guard (an attacker page on evil.com:3005 must not be same-origin).
      const hostname = (hostHeader ?? '').replace(/:\d+$/, '').toLowerCase();
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
        throw new AppError(403, 'bad_host', 'browser sessions are only minted for a loopback host name');
      }
    };

    // Loopback auto-connect: a browser on this machine becomes `human` without
    // a paste.
    app.post('/api/connect', async (request, reply) => {
      browserOnly(request);
      // Rotate: the browser's previous id (if any) stops working immediately.
      const previous = readSessionId(request.headers.cookie);
      if (previous !== null) identity.sessions.delete(previous);
      const principal: Principal = { name: 'human', kind: 'human' };
      const id = identity.sessions.create(principal);
      reply.header('set-cookie', sessionCookie(id));
      return principal;
    });

    // Idempotent: a dead cookie (or none) still returns 200 and clears it, so a
    // reload after a restart does not surface an error.
    app.post('/api/disconnect', async (request, reply) => {
      browserOnly(request);
      const id = readSessionId(request.headers.cookie);
      if (id !== null) identity.sessions.delete(id);
      reply.header('set-cookie', clearSessionCookie());
      return { status: 'ok' };
    });
  } else if (mode === 'open' || mode === 'shared-token') {
    // Explain the refusal instead of 404: the dashboard asks this on load.
    app.post('/api/connect', async () => {
      throw new AppError(
        403,
        mode === 'open' ? 'auth_mode_open' : 'auth_mode_shared_token',
        mode === 'open'
          ? 'no identities are configured (no .data/peer-auth.json); nothing to connect as'
          : 'this server uses a shared token; paste it in Settings instead of connecting a browser',
      );
    });
  }

  app.get('/api/messages', async (request) => {
    const raw = messagesQuerySchema.parse(request.query);
    const query = parseMessageQuery(raw);
    const page = await service.queryMessages(query);
    return { messages: page.rows, hasMore: page.hasMore };
  });

  app.get('/api/last-activity', async () => service.lastActivity());

  app.post('/send', { preHandler: sendAuth }, async (request) => {
    const body = sendBodySchema.parse(request.body);
    const principal = request.principal;
    if (principal === undefined) {
      // Legacy open mode: the body carries the sender (human | boss only).
      return service.sendMessage({ to: body.to, message: body.message, from: body.from });
    }
    // A body `from` is a CLAIM; the credential is the identity. A mismatch is
    // impersonation, so it is loud rather than silently overwritten.
    if (body.from !== undefined && body.from !== principal.name) {
      throw new AppError(403, 'identity_mismatch', `from does not match the authenticated principal (${principal.name})`);
    }
    return service.sendMessage({
      to: body.to,
      message: body.message,
      from: principal.name,
      authenticated: true,
      ...(body.messageId === undefined ? {} : { messageId: body.messageId }),
    });
  });

  app.post('/prompt', { preHandler: sendAuth }, async (request) => {
    const body = promptBodySchema.parse(request.body);
    // Webchat is the human's channel: an agent principal may not drive it.
    if (request.principal !== undefined && request.principal.kind !== 'human') {
      throw new AppError(403, 'forbidden_principal', 'the webchat prompt is reserved for the human principal');
    }
    return service.promptBoss(body.message);
  });

  // POST /webhook (bridge.mjs:342-363) — legacy capture path. NOT gated by the
  // optional bearer token (decision 4 gates /send + /prompt only; the bridge
  // has no auth here). Its own encapsulation scope so the body parser mirrors
  // the bridge's content-type-agnostic JSON.parse of the raw body
  // (bridge.mjs:343-346): Fastify's default parser only accepts
  // application/json and reports parse failures with its own error text.
  app.register(async (scope) => {
    const rawBody = (
      _request: unknown,
      body: unknown,
      done: (err: Error | null, body?: unknown) => void,
    ): void => {
      done(null, body);
    };
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, rawBody);
    scope.addContentTypeParser('*', { parseAs: 'string' }, rawBody);
    scope.post('/webhook', async (request) => {
      const body = webhookBodySchema.parse(parseWebhookJson(request.body));
      return service.webhookMessage(body);
    });
  });
}

// bridge.mjs:345-346,359-361 — JSON.parse over the raw body; ANY parse failure
// (malformed or empty body) → 400 with the bridge's exact text, enveloped per
// the standing ruling (envelope shape stays, message text stays byte-identical).
function parseWebhookJson(body: unknown): unknown {
  try {
    return JSON.parse(typeof body === 'string' ? body : '');
  } catch {
    throw new AppError(400, 'invalid_json', 'Invalid JSON');
  }
}
