// Liveness probe. No business logic, no auth (deliberately — always reachable).
import type { FastifyInstance } from 'fastify';

export function healthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => ({ status: 'ok' }));
}
