// Chat-module test support: a fake Phase 3 OpenCode integration (no live
// server, no canonical db) and a ChatService assembler over a temp db.
import { join } from 'node:path';
import type { OpenCodeIntegration } from '../src/integrations/opencode/index.js';
import type { NormalizedEvent, SessionResolver } from '../src/integrations/opencode/events.js';
import type { PortErrorCode } from '../src/integrations/opencode/errors.js';
import { PortError } from '../src/integrations/opencode/errors.js';
import { openDatabase, runMigrations, migrationsFolder } from '../src/infrastructure/database/client.js';
import { EventBus } from '../src/infrastructure/events/bus.js';
import { ChatMessageRepository } from '../src/modules/chat/infrastructure/message-repository.js';
import { ChatService } from '../src/modules/chat/application/chat-service.js';
import type { ChatRegistry, RegistrySnapshot } from '../src/modules/chat/application/ports.js';
import { tempDir } from './helpers.js';

export interface FakeOpenCode {
  readonly integration: OpenCodeIntegration;
  /** Recorded prompt calls, in order. */
  readonly promptCalls: Array<{ sessionId: string; text: string }>;
  /** Configurable pending-user-input answer per session id (default false). */
  readonly pendingInput: Map<string, boolean>;
  /** Configure prompt outcomes per session id: undefined = resolve; a code = reject. */
  readonly promptOutcome: Map<string, PortErrorCode>;
  /** Neutral availability (default true). Set false to simulate "no effective
   *  server URL" (bridge !SERVER_URL — finding 3 semantics). */
  available: boolean;
  /** Deliver a normalized event through the subscribed sink (as the stream would). */
  deliver(event: NormalizedEvent): Promise<void>;
  /** The resolver the composition root registered (for direct checks). */
  resolveSession(sessionId: string): ReturnType<SessionResolver>;
  /** Gate to hold prompt promises open mid-flight (lastPromptFrom race tests). */
  readonly holdPrompts: Set<string>;
}

export function fakeOpenCode(): FakeOpenCode {
  const promptCalls: FakeOpenCode['promptCalls'] = [];
  const pendingInput = new Map<string, boolean>();
  const promptOutcome = new Map<string, PortErrorCode>();
  const holdPrompts = new Set<string>();
  let available = true;
  let handler: ((event: NormalizedEvent) => void | Promise<void>) | null = null;
  let resolver: SessionResolver | null = null;
  const integration: OpenCodeIntegration = {
    events: {
      subscribe(h, r) {
        handler = h;
        resolver = r;
        return () => {};
      },
    },
    sessions: {
      async hasPendingUserInput(sessionId) {
        return pendingInput.get(sessionId) ?? false;
      },
    },
    prompts: {
      isAvailable: () => available,
      prompt(sessionId, text) {
        promptCalls.push({ sessionId, text });
        if (holdPrompts.has(sessionId)) {
          return new Promise<void>(() => {}); // held open until the test resolves it
        }
        const code = promptOutcome.get(sessionId);
        if (code !== undefined) return Promise.reject(new PortError(code, 'fake failure'));
        return Promise.resolve();
      },
    },
  };
  return {
    integration,
    promptCalls,
    pendingInput,
    promptOutcome,
    get available() {
      return available;
    },
    set available(value: boolean) {
      available = value;
    },
    holdPrompts,
    deliver: async (event) => {
      if (handler === null) throw new Error('chat sink not subscribed');
      await handler(event);
    },
    resolveSession: (sessionId) => (resolver === null ? null : resolver(sessionId)),
  };
}

/** Fixed in-memory registry (unit tests). */
export function fakeRegistry(snapshot: RegistrySnapshot): ChatRegistry {
  return {
    read: async () => snapshot,
    loadSync: () => snapshot,
  };
}

export interface ChatFixture {
  readonly dir: string;
  readonly dbPath: string;
  readonly bus: EventBus;
  readonly store: ChatMessageRepository;
  readonly service: ChatService;
}

/** A ChatService over a fresh temp db (real store + real bus, injected fakes
 *  for the registry and the OpenCode ports). */
export function makeChatFixture(registry: ChatRegistry, opencode = fakeOpenCode()): ChatFixture & { opencode: FakeOpenCode } {
  const dir = tempDir();
  const dbPath = join(dir, 'chat.db');
  const { sqlite, db } = openDatabase(dbPath);
  runMigrations(db, migrationsFolder());
  const bus = new EventBus(sqlite);
  const store = new ChatMessageRepository(sqlite);
  const service = new ChatService({ store, registry, ports: { prompts: opencode.integration.prompts, sessions: opencode.integration.sessions, bus } });
  return { dir, dbPath, bus, store, service, opencode };
}

/** Registry snapshot matching agents.example.json's real-world shape. */
export function exampleRegistry(): RegistrySnapshot {
  return {
    serverUrl: 'http://localhost:4096',
    boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
    agents: [
      { name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow' },
      { name: 'immigapp', project: 'ImmigApp', session: 'ses_immigapp' },
    ],
  };
}
