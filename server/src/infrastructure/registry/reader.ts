// Shared infrastructure — agents.json registry reader (Coordinator Phase 2
// ruling, Boss-confirmed): the registry FILE stays the runtime source of truth
// (decision 3); every read() re-reads the file (bridge-faithful — the bridge
// re-reads per request/per event line, so agents added at runtime are usable
// without a restart). Registry CRUD is NOT built here. The agents/projects
// mirror tables are refreshed by the agents module (AgentsService.replaceAll);
// this reader no longer writes to the db (registry_mirror was dropped in 0004).
//
// Fresh-clone behavior (dev worktree has NO agents.json): an ABSENT file is
// the documented graceful default — an empty registry (no boss, no agents), so
// tests and fresh clones run. A PRESENT-but-malformed file throws an AppError
// (500 envelope via the shared error handler), matching the bridge's loud
// failure mode (bridge.mjs:14-19 exits; per-request we fail that request).
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from '../../shared/errors/index.js';
import type { ChatRegistry, RegistrySnapshot } from '../../modules/chat/application/ports.js';

const registryFileSchema = z.object({
  serverUrl: z.string().optional(),
  boss: z
    .object({ name: z.string().min(1), project: z.string(), session: z.string().min(1) })
    .optional(),
  agents: z
    .array(z.object({ name: z.string().min(1), project: z.string(), session: z.string().min(1) }))
    .default([]),
});

const EMPTY: RegistrySnapshot = { serverUrl: null, boss: null, agents: [] };

/** agents.json `serverUrl` as the adapter's startup fallback URL (bridge.mjs:31:
 *  `return config.serverUrl || null`). The value must be a FULL, VALID http(s)
 *  URL — the same bar the adapter's zod config (`z.url()`) enforces — so an
 *  invalid value (e.g. `"http://"`, which passes a prefix check) is treated as
 *  ABSENT here: logged and ignored, startup proceeds, and discovery / the env
 *  override still apply. Absent / malformed / unreadable registry → null
 *  (graceful; per-request registry reads still fail loud). */
export function registryFallbackServerUrl(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = (raw as { serverUrl?: unknown }).serverUrl;
  if (typeof candidate !== 'string' || candidate === '') return null;
  const parsed = z.url().safeParse(candidate);
  if (!parsed.success) {
    // The bridge would pass any truthy string through and fail later; failing
    // the whole startup for a bad fallback would be worse — log and continue
    // without it (finding 1: invalid value must not stop startup).
    console.warn(`[registry] ignoring invalid agents.json serverUrl (not a valid URL): ${JSON.stringify(candidate)}`);
    return null;
  }
  return candidate;
}

export class JsonRegistryReader implements ChatRegistry {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  /** Per-request re-read (async — routes call this). */
  async read(): Promise<RegistrySnapshot> {
    return this.#parse(await this.#readRaw());
  }

  /** Synchronous raw loader for createSessionResolver (per-event-line re-read,
   *  bridge.mjs:161-163). Throws on a malformed PRESENT file; the resolver
   *  treats a throw as "unknown session" for that event. */
  loadSync(): unknown {
    return JSON.parse(readFileSync(this.#filePath, 'utf8'));
  }

  /** Synchronous startup read (decision 3: the bridge reads agents.json ONCE
   *  at startup, bridge.mjs:14-19, while per-request reads stay async). Same
   *  semantics as read(): an ABSENT file is the documented graceful empty
   *  registry; a PRESENT-but-broken file throws (the bridge exits loudly there
   *  — the composition root decides what to do). */
  readSync(): RegistrySnapshot {
    let raw: unknown;
    try {
      raw = this.loadSync();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY; // absent = empty registry
      throw err;
    }
    return this.#parse(raw);
  }

  async #readRaw(): Promise<unknown> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // absent = empty registry
      throw new AppError(500, 'registry_unavailable', `Cannot read registry file ${this.#filePath}`);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new AppError(500, 'registry_unavailable', `Registry file ${this.#filePath} is not valid JSON`);
    }
  }

  #parse(raw: unknown): RegistrySnapshot {
    if (raw === null) return EMPTY; // absent file → documented empty registry
    const parsed = registryFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        500,
        'registry_unavailable',
        `Registry file ${this.#filePath} is malformed: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    const boss = parsed.data.boss
      ? { name: parsed.data.boss.name, project: parsed.data.boss.project, session: parsed.data.boss.session }
      : null;
    return {
      serverUrl: parsed.data.serverUrl ?? null,
      boss,
      agents: parsed.data.agents.map((a) => ({ name: a.name, project: a.project, session: a.session })),
    };
  }
}
