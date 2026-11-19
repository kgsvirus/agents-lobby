// Principal resolution for the send endpoints (peer messaging).
//
// A bearer token maps to a principal; the principal - never the request body -
// decides who the sender is. When no `.data/peer-auth.json` exists the map is
// undefined and the legacy body-`from` behavior stays in force (decision 4 /
// the pre-peer lobby). Constant-time comparison keeps the check honest about
// timing regardless of token length.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '../../infrastructure/config/index.js';
import { AppError } from '../../shared/errors/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by resolvePrincipal when a token matched; absent otherwise. */
    principal?: Principal;
  }
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function tokenToPrincipal(
  principals: ReadonlyMap<string, Principal>,
  authorization: string | undefined,
): Principal | undefined {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return undefined;
  const presented = authorization.slice('Bearer '.length);
  for (const [token, principal] of principals) {
    if (tokensEqual(token, presented)) return principal;
  }
  return undefined;
}

/** Resolves the principal and throws the shared 401 envelope when the token is
 *  missing, malformed or unknown. Use on routes that require an identity. */
export function requirePrincipal(principals: ReadonlyMap<string, Principal>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const principal = tokenToPrincipal(principals, request.headers.authorization);
    if (principal === undefined) {
      reply.header('www-authenticate', 'Bearer realm="agents-lobby"');
      throw new AppError(401, 'unauthorized', 'Missing or invalid bearer token');
    }
    request.principal = principal;
  };
}
