// Application composition root. Builds the Fastify instance with db,
// migrations, event bus, error handling, the OpenCode integration (Phase 3)
// and the chat module (Phase 4). Returns the instance UN-booted so tests can
// register additional routes before ready() and inject fake ports.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from './infrastructure/config/index.js';
import { migrationsFolder, openDatabase, runMigrations } from './infrastructure/database/client.js';
import { EventBus } from './infrastructure/events/bus.js';
import { JsonRegistryReader, registryFallbackServerUrl } from './infrastructure/registry/reader.js';
import { wireMessageSchema, type WireMessage } from './shared/schemas/wire.js';
import { registerErrorHandler } from './api/plugins/error-handler.js';
import { healthRoutes } from './api/routes/health.js';
import { eventsRoutes } from './api/routes/events.js';
import { uiRoutes, defaultUiRoot } from './api/routes/ui.js';
import { createOpenCodeIntegration, type OpenCodeIntegration } from './integrations/opencode/index.js';
// Session-resolver + wake-text helpers come through the adapter's ENTRY SURFACE
// (the documented split points, exported consciously from index.ts — the
// resolver maps session handles to domain names (per-event-line registry
// re-read) and the wake prompt format is adapter-owned (byte-identical
// contract). Both are pure; no transport crosses here.
import { createSessionResolver } from './integrations/opencode/index.js';
import { ChatMessageRepository } from './modules/chat/infrastructure/message-repository.js';
import { readPeerAllowlist } from './modules/chat/infrastructure/peer-allowlist.js';
import { SessionStore } from './api/middleware/session.js';
import { ChatService } from './modules/chat/application/chat-service.js';
import { chatRoutes } from './modules/chat/presentation/routes.js';
import { AgentMirrorRepository } from './modules/agents/infrastructure/agent-mirror-repository.js';
import { AgentsService } from './modules/agents/application/agents-service.js';
import { agentsRoutes } from './modules/agents/presentation/routes.js';
import { ProjectsService } from './modules/projects/application/projects-service.js';
import { projectsRoutes } from './modules/projects/presentation/routes.js';
import { readLocalProjects } from './modules/projects/infrastructure/local-projects-reader.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The single-process event bus (single shared events sequence). */
    bus: EventBus;
    /** The assembled chat application service (wired by this composition root). */
    chat: ChatService;
    /** The assembled agents application service (wired by this composition root). */
    agents: AgentsService;
  }
}

/** Pino redaction for every lobby process. Exported so a test can assert the
 *  real list instead of a copy: `server.ts` is an entry module and cannot be
 *  imported by a test. */
export const LOG_REDACTION = ['req.headers.authorization', 'req.headers.cookie'];

export interface BuildAppOptions {
  /** Request logging (Fastify/pino). Default false; server.ts enables it. */
  readonly logger?: boolean;
  /** Injected OpenCode integration. Default: the real Phase 3 adapter
   *  (with server-URL discovery — production path). Tests MUST inject fakes:
   *  no test may contact a live OpenCode server. */
  readonly opencode?: OpenCodeIntegration;
  /** Test-only SSE heartbeat override (EventsRouteOptions.heartbeatMs).
   *  Undefined = the production 25 s interval. */
  readonly eventsHeartbeatMs?: number;
  /** Pino redaction paths (default none). server.ts passes
   *  `req.headers.authorization` so bearer tokens never reach the log. */
  readonly loggerRedact?: string[];
}

export function buildApp(config: AppConfig, options: BuildAppOptions = {}): FastifyInstance {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const { sqlite, db } = openDatabase(config.dbPath);
  runMigrations(db, migrationsFolder());
  const bus = new EventBus(sqlite);

  // Phase 4 chat module wiring: store repository (same sqlite handle as the
  // bus — ingest transaction joins), per-request registry reader, injected
  // (or real) OpenCode ports.
  const registry = new JsonRegistryReader(config.registryPath);
  const store = new ChatMessageRepository(sqlite);
  // Phase 5 agents module wiring: the SAME per-request registry reader (chat's
  // contract unchanged) plus the read-only agents/projects mirror store.
  const agentMirror = new AgentMirrorRepository(db);
  const agentsService = new AgentsService({ registry, mirror: agentMirror });

  // Startup registry read ONCE (the bridge reads agents.json once for startup
  // config, bridge.mjs:14-38): readSync parses it — the snapshot then seeds
  // the agents/projects mirror below. An absent file is the graceful
  // empty-registry default; an unreadable/malformed one leaves the mirrors empty here (per-request reads
  // fail loud instead — the bridge exits, the documented new-stack behavior
  // fails that request).
  let startupSnapshot: ReturnType<typeof registry.readSync> | null = null;
  try {
    startupSnapshot = registry.readSync();
  } catch (err) {
    // Fail-soft startup is deliberate (fail loud per request instead — the
    // bridge exits, bridge.mjs:14-19), but the operator must SEE why: an
    // unreadable/malformed agents.json is logged with its cause here. A
    // MISSING file never reaches this catch (readSync treats ENOENT as the
    // documented graceful fresh-clone empty registry, silently).
    console.error(`[registry] agents.json startup read failed (${config.registryPath}):`, err);
  }
  //
  // Effective server URL precedence (documented, decision 4 contract):
  //   1. discovery inside the adapter (`opencode service status`) — bridge.mjs:22-34
  //   2. LOBBY_OPENCODE_SERVER_URL (explicit operator override)
  //   3. agents.json serverUrl (the bridge's startup fallback, bridge.mjs:31)
  // The registry value is read ONCE here at startup (the bridge also reads
  // agents.json once for startup config, bridge.mjs:14-38); per-request
  // registry re-reads are unaffected. An absent/malformed registry file at
  // startup contributes no fallback (graceful fresh-clone default).
  const registryFallback = registryFallbackServerUrl(
    startupSnapshot === null ? null : { serverUrl: startupSnapshot.serverUrl },
  );
  agentsService.syncStartup(startupSnapshot);
  const opencode =
    options.opencode ??
    createOpenCodeIntegration({
      fallbackServerUrl: config.opencodeServerUrl ?? registryFallback,
      timeoutMs: config.opencodeTimeoutMs,
    });
  const chat = new ChatService({
    store,
    registry,
    ports: { prompts: opencode.prompts, sessions: opencode.sessions, bus },
    readAllowlist: () => readPeerAllowlist(config.peerAllowlistPath),
  });
  // One store per process: browser sessions are server state, like the wake
  // bookmark, and must not be re-created per request.
  const sessions = new SessionStore();
  // Fail-closed is correct but silent: an operator who created principals
  // expects the policy file to exist, and a missing one denies every send.
  if (config.peerAuth !== undefined && !existsSync(config.peerAllowlistPath)) {
    console.warn(
      `[chat] peer policy file not found at ${config.peerAllowlistPath} (relative to the run directory): every authenticated send will be refused`,
    );
  }

  const app = Fastify({
    logger: options.logger ?? false,
    ...(options.loggerRedact ? { redact: options.loggerRedact } : {}),
    bodyLimit: config.bodyLimit,
    // SSE connections are hijacked and never "finish"; without this the
    // process hangs in app.close() waiting on them.
    forceCloseConnections: true,
  });

  registerErrorHandler(app);
  app.decorate('bus', bus);
  app.decorate('chat', chat);
  app.decorate('agents', agentsService);
  app.register(healthRoutes);
  app.register(chatRoutes, {
    service: chat,
    authToken: config.authToken,
    principals: config.peerAuth,
    sessions,
    host: config.host,
  });
  app.register(agentsRoutes, { service: agentsService });
  // Decision-2 compatibility: machine-local projects listing consumed by the
  // dashboard's Projects module (Task-1 ledger ruling).
  app.register(
    projectsRoutes,
    { service: new ProjectsService({ rootDir: config.projectsDir, reader: readLocalProjects }) },
  );

  // Wire-alias lookup mirroring store.mjs:17. shortcut: Phase 4's chat
  // repository owns message persistence and replaces this inline accessor.
  const messageById = sqlite.prepare(
    'SELECT id, ts AS time, sender AS "from", receiver AS "to", body AS text FROM messages WHERE id = ?',
  );
  const messageFor = (id: number): WireMessage | null => {
    const row: unknown = messageById.get(id);
    return row === undefined ? null : wireMessageSchema.parse(row);
  };
  app.register(eventsRoutes, {
    messageFor,
    heartbeatMs: options.eventsHeartbeatMs,
  });

  // /ui static serving (decision 2): the web/ Next.js export, bridge cache
  // semantics. Missing export dir → per-file 404s (bridge's failed readFile).
  app.register(uiRoutes, { rootDir: config.uiDir ?? defaultUiRoot() });

  // The Phase 3 event-stream sink: normalized events flow into the chat
  // application (boss-only filter, echo suppression, reply routing, wake).
  // The promise is RETURNED, not voided: an ingest failure (db write /
  // event-persistence error) rejects into the adapter's handler-error path
  // (pumpSseStream catch → logged, stream keeps running) instead of becoming
  // an unhandled rejection. Session resolution re-reads the registry per
  // event line (bridge-faithful).
  const unsubscribeEvents = opencode.events.subscribe(
    (event) => chat.handleEvent(event),
    createSessionResolver(() => registry.loadSync()),
  );

  app.addHook('onClose', async () => {
    unsubscribeEvents();
    bus.close();
    sqlite.close();
  });

  // Peer delivery reconciliation: one attempt per row that was archived but
  // never confirmed. Fire-and-forget - startup must not wait on OpenCode, and
  // a failure is logged, never thrown.
  void chat.reconcileDeliveries().catch((err: unknown) => {
    console.error('[chat] delivery reconciliation failed:', err);
  });

  return app;
}
