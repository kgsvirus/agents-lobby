// Agents infrastructure — the drizzle-backed mirror store (decision 3).
// Full-rewrite replace inside one transaction; reads reproduce the registry
// file order via the `ordinal` column.
import { asc } from 'drizzle-orm';
import type { LobbyDb } from '../../../infrastructure/database/client.js';
import { agents, projects } from '../../../infrastructure/database/schema.js';
import { projectNames, type Agent } from '../domain/agent.js';
import type { AgentMirrorStore } from '../application/ports.js';

export class AgentMirrorRepository implements AgentMirrorStore {
  readonly #db: LobbyDb;

  constructor(db: LobbyDb) {
    this.#db = db;
  }

  replaceAll(rows: readonly Agent[]): void {
    this.#db.transaction((tx) => {
      tx.delete(agents).run();
      tx.delete(projects).run();
      for (const name of projectNames(rows)) tx.insert(projects).values({ name }).run();
      for (const [ordinal, a] of rows.entries()) {
        tx.insert(agents).values({ name: a.name, project: a.project, session: a.session, ordinal }).run();
      }
    });
  }

  listAgents(): Agent[] {
    return this.#db
      .select({ name: agents.name, project: agents.project, session: agents.session })
      .from(agents)
      .orderBy(asc(agents.ordinal))
      .all();
  }
}
