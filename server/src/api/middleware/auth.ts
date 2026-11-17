// Optional shared-secret bearer check (decision 4). Wired by the routes that
// opt in: chat's /send + /prompt (the decision-4 scope). /api/events, the
// other reads, /ui and /webhook stay open even when a token is configured
// (EventSource cannot send an Authorization header; documented limitation:
// the dashboard composer's /send//prompt calls return 401 with a token set).
// When no gitignored auth file exists there is NO token and NO hook: access
// stays open, matching today's bridge behavior.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../shared/errors/index.js';

export function bearerCheck(token: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.headers.authorization === `Bearer ${token}`) return;
    reply.header('www-authenticate', 'Bearer realm="agents-lobby"');
    throw new AppError(401, 'unauthorized', 'Missing or invalid bearer token');
  };
}
