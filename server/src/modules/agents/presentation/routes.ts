// Agents presentation — thin Fastify routes (modules/agents/presentation).
//
// No business logic: GET /api/agents delegates to the AgentsService. No query
// params exist to validate — the bridge accepts NONE (bridge.mjs:255
// exact-matches req.url, so ANY query string falls through to its catch-all
// 404, bridge.mjs:445 — parity enforced by the guard below). Not auth-gated
// (decision 4 gates /send + /prompt only; the bridge has no auth here either).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentsService } from '../application/agents-service.js';
import { errorEnvelope } from '../../../shared/errors/index.js';

export interface AgentsRoutesOptions {
  readonly service: AgentsService;
}

export function agentsRoutes(app: FastifyInstance, opts: AgentsRoutesOptions): void {
  // bridge.mjs:255 matches the EXACT request URL "/api/agents"; anything else
  // (a query string, an encoded path) falls through to the catch-all
  // json(404, { error: "not found" }) — bridge.mjs:445. Fastify routes match
  // the path only, so the guard restores the bridge's exact-URL semantics:
  // 404, with the bridge's message text byte-identical inside the shared
  // envelope (standing error-envelope ruling).
  const exactUrl = (request: FastifyRequest): boolean => request.url === '/api/agents';
  app.get('/api/agents', async (request, reply) => {
    if (!exactUrl(request)) {
      return reply.status(404).send(errorEnvelope('not_found', 'not found'));
    }
    return opts.service.listAgents();
  });
}
