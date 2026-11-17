// Projects presentation — thin Fastify routes. GET /api/local-projects is a
// decision-2 compatibility route (Task-1 ledger ruling): the live dashboard's
// Projects module consumes it. Query strings are ALLOWED — the bridge matches
// the URL PATHNAME only (bridge.mjs:329-331), unlike /api/agents.
//
// Validation: no params exist to validate (bridge accepts none). Errors map
// to the shared envelope with bridge-identical status (500) and message text
// (the readdir failure's err.message, bridge.mjs:332-338) — standing ruling.
import type { FastifyInstance } from 'fastify';
import type { ProjectsService } from '../application/projects-service.js';
import { AppError } from '../../../shared/errors/index.js';

export interface ProjectsRoutesOptions {
  readonly service: ProjectsService;
}

export function projectsRoutes(app: FastifyInstance, opts: ProjectsRoutesOptions): void {
  app.get('/api/local-projects', async () => {
    try {
      return await opts.service.listLocalProjects();
    } catch (err) {
      // Controlled failure: the bridge never lets a readdir rejection escape
      // the handler (bridge.mjs:332-338). Not auth-gated (decision 4 gates
      // /send + /prompt only; the bridge has no auth here either).
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(500, 'local_projects_failed', message);
    }
  });
}
