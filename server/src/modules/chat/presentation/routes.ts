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
import { bearerCheck } from '../../../api/middleware/auth.js';
import { requirePrincipal } from '../../../api/middleware/peer-auth.js';
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
}

export function chatRoutes(app: FastifyInstance, opts: ChatRoutesOptions): void {
  const service = opts.service;
  const principals = opts.principals;
  // Route-level preHandler so the token gates ONLY /send + /prompt.
  // Identity mode (peer-auth file present) replaces the legacy shared token:
  // the principal, not the body, decides who is sending.
  const peerGuard = principals === undefined ? undefined : requirePrincipal(principals);
  const sendAuth = principals !== undefined ? peerGuard : opts.authToken === undefined ? undefined : bearerCheck(opts.authToken);

  // Identity check for the dashboard's Connect button: verifies a pasted token
  // without sending a message. Registered only when identities exist.
  if (principals !== undefined) {
    app.get('/api/principal', { preHandler: peerGuard }, async (request) => request.principal);
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
