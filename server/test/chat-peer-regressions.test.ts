// Peer messaging - regression pins for the review findings.
//
// Each test names the defect it prevents from coming back:
//   R1 identity is decided by the credential kind, not by the name alone
//   R2 a peer send to `human` also arms the sender-turn suppressor
//   R3 an inbound enqueued mid-turn never loses the next reply
//   R4 retrying an undelivered message reports skipped, not sent
//   R5 an idempotency key is owned by its sender (and a lost race is a hit)
//   R6 a peer name cannot forge an authority prefix
//   R7 boss bookmark advances past rows filtered out of the wake slice
//   R8 a failed arm-clear fails OPEN (archives) and startup clears stale arms
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/infrastructure/config/index.js';
import { isComposablePeerName } from '../src/modules/chat/domain/prefix.js';
import { EventBus } from '../src/infrastructure/events/bus.js';
import { openDatabase, runMigrations, migrationsFolder } from '../src/infrastructure/database/client.js';
import { ChatMessageRepository } from '../src/modules/chat/infrastructure/message-repository.js';
import { ChatService } from '../src/modules/chat/application/chat-service.js';
import { fakeOpenCode, fakeRegistry, makeChatFixture } from './chat-fakes.js';
import { tempDir } from './helpers.js';

const registry = fakeRegistry({
  serverUrl: null,
  boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
  agents: [
    { name: 'ruben', project: 'TaskFlow', session: 'ses_ruben', role: 'coordinator' },
    { name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow', role: 'developer' },
  ],
});

const ALLOWLIST = {
  human: ['boss', 'coordinator', 'developer'],
  boss: ['human', 'coordinator', 'developer'],
  coordinator: ['human', 'boss', 'developer'],
  developer: ['human', 'boss', 'coordinator'],
};

const peerSend = (extra: Record<string, unknown> = {}) => ({
  to: 'boss',
  message: 'hello',
  from: 'ruben',
  authenticated: true,
  messageId: 'msg_1',
  ...extra,
});

function peerAuthConfig(tokens: Record<string, { name: string; kind: string }>) {
  const dir = tempDir();
  const file = join(dir, 'peer-auth.json');
  writeFileSync(file, JSON.stringify({ tokens }));
  return () =>
    loadConfig({
      env: { LOBBY_DB_PATH: join(dir, 'x.db') },
      authFile: join(dir, 'absent.json'),
      peerAuthFile: file,
    });
}

describe('R1 - credential kind decides authority, not the name', () => {
  it('refuses an agent principal named like an authority', () => {
    expect(peerAuthConfig({ t: { name: 'boss', kind: 'agent' } })).toThrow(/must not be "human" or "boss"/);
    expect(peerAuthConfig({ t: { name: 'human', kind: 'agent' } })).toThrow(/must not be "human" or "boss"/);
  });

  it('requires the authority kinds to use their own name', () => {
    expect(peerAuthConfig({ t: { name: 'alice', kind: 'human' } })).toThrow(/must be named "human"/);
    expect(peerAuthConfig({ t: { name: 'chief', kind: 'boss' } })).toThrow(/must be named "boss"/);
  });

  it('accepts a well-formed map', () => {
    const config = peerAuthConfig({
      a: { name: 'human', kind: 'human' },
      b: { name: 'boss', kind: 'boss' },
      c: { name: 'ruben', kind: 'agent' },
    })();
    expect([...(config.peerAuth?.values() ?? [])]).toEqual([
      { name: 'human', kind: 'human' },
      { name: 'boss', kind: 'boss' },
      { name: 'ruben', kind: 'agent' },
    ]);
  });
});

describe('R2 - the arm belongs to the sender turn, whatever the recipient', () => {
  it('peer -> human arms suppression, so the turn is not archived twice', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.sendMessage(peerSend({ to: 'human' }));
    expect(f.store.isCaptureSuppressed('ses_ruben')).toBe(true);
    // The turn transcript is skipped: one row (the archived body), no wake.
    await f.service.handleEvent({
      kind: 'reply',
      from: 'ruben',
      to: null,
      body: 'Sent it.',
      sessionId: 'ses_ruben',
      ts: '2026-11-19T10:00:05.000Z',
    });
    const rows = f.store.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
    expect(rows.map((r) => r.text)).toEqual(['hello']);
    expect(f.store.isCaptureSuppressed('ses_ruben')).toBe(false); // consumed
    expect(f.opencode.promptCalls.filter((c) => c.sessionId === 'ses_boss')).toEqual([]);
  });
});

describe('R3 - an inbound enqueued mid-turn never loses the next reply', () => {
  it('a reply after the arm was cleared is archived (duplicate tolerated, loss is not)', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.sendMessage(peerSend({ to: 'taskflow' }));
    // A prompt is enqueued into ruben's session while its turn still runs.
    await f.service.handleEvent({
      kind: 'inbox',
      from: 'human',
      to: 'ruben',
      body: 'Peer taskflow: ack',
      sessionId: 'ses_ruben',
      ts: '2026-11-19T10:00:01.000Z',
    });
    expect(f.store.isCaptureSuppressed('ses_ruben')).toBe(false);
    await f.service.handleEvent({
      kind: 'reply',
      from: 'ruben',
      to: null,
      body: 'real answer to taskflow',
      sessionId: 'ses_ruben',
      ts: '2026-11-19T10:00:02.000Z',
    });
    const rows = f.store.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
    expect(rows.at(-1)).toMatchObject({ from: 'ruben', to: 'taskflow', text: 'real answer to taskflow' });
  });
});

describe('R4 - retry reports delivery state, not a blind success', () => {
  it('an archived-but-undelivered row retries as skipped', async () => {
    const opencode = fakeOpenCode();
    opencode.promptOutcome.set('ses_boss', 'unreachable');
    const f = makeChatFixture(registry, opencode, ALLOWLIST);
    const first = await f.service.sendMessage(peerSend());
    expect(first).toEqual({ sent: [], skipped: ['boss'], messageId: 'msg_1' });
    const retry = await f.service.sendMessage(peerSend());
    expect(retry).toEqual({ sent: [], skipped: ['boss'], messageId: 'msg_1' });
    expect(opencode.promptCalls).toHaveLength(1); // no second prompt
  });

  it('a delivered row retries as sent', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.sendMessage(peerSend());
    expect(await f.service.sendMessage(peerSend())).toEqual({ sent: ['boss'], skipped: [], messageId: 'msg_1' });
  });
});

describe('R5 - idempotency keys are sender-scoped', () => {
  it("another sender cannot claim ruben's key", async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), {
      coordinator: ['boss'],
      developer: ['boss', 'human'],
    });
    await f.service.sendMessage(peerSend()); // ruben, msg_1 -> boss
    const other = await f.service.sendMessage(peerSend({ from: 'taskflow', to: 'human' }));
    // taskflow's send is its OWN row, not a replay of ruben's.
    expect(other.sent).toEqual(['human']);
    const rows = f.store.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
    expect(rows.map((r) => [r.from, r.to])).toEqual([
      ['ruben', 'boss'],
      ['taskflow', 'human'],
    ]);
  });
});

describe('R6 - a peer name cannot forge an authority prefix', () => {
  it('rejects names that would break the prefix line', () => {
    expect(isComposablePeerName('ruben')).toBe(true);
    expect(isComposablePeerName('x\nHuman')).toBe(false);
    expect(isComposablePeerName('a:b')).toBe(false);
    expect(isComposablePeerName('human')).toBe(false);
    expect(isComposablePeerName('boss')).toBe(false);
    expect(isComposablePeerName('')).toBe(false);
  });
});

describe('R8 - a failed arm-clear fails open', () => {
  function serviceWithFlakyClear(failClears: { count: number }) {
    const dir = tempDir();
    const { sqlite, db } = openDatabase(join(dir, 'r8.db'));
    runMigrations(db, migrationsFolder());
    const bus = new EventBus(sqlite);
    const real = new ChatMessageRepository(sqlite);
    const store = {
      insert: real.insert.bind(real),
      busyTimeout: real.busyTimeout.bind(real),
      setBusyTimeout: real.setBusyTimeout.bind(real),
      query: real.query.bind(real),
      unread: real.unread.bind(real),
      markSeen: real.markSeen.bind(real),
      lastActivity: real.lastActivity.bind(real),
      findOwnMessage: real.findOwnMessage.bind(real),
      isMessageIdConflict: real.isMessageIdConflict.bind(real),
      isCaptureSuppressed: real.isCaptureSuppressed.bind(real),
      clearAllCaptureSuppressed: real.clearAllCaptureSuppressed.bind(real),
      markDeliverySent: real.markDeliverySent.bind(real),
      markDeliveryRetried: real.markDeliveryRetried.bind(real),
      unconfirmedPeerDeliveries: real.unconfirmedPeerDeliveries.bind(real),
      clearCaptureSuppressed: (sessionId: string) => {
        if (failClears.count > 0) {
          failClears.count -= 1;
          throw new Error('SQLITE_BUSY (injected)');
        }
        real.clearCaptureSuppressed(sessionId);
      },
    };
    const opencode = fakeOpenCode();
    const service = new ChatService({
      store,
      registry,
      ports: { prompts: opencode.integration.prompts, sessions: opencode.integration.sessions, bus },
      readAllowlist: async () => ALLOWLIST,
    });
    return { service, real, opencode };
  }

  it('archives the next reply instead of suppressing it', async () => {
    const { service, real, opencode } = serviceWithFlakyClear({ count: 1 });
    await service.sendMessage(peerSend({ to: 'taskflow' }));
    // The inbound clear fails (busy): the arm survives IN THE DB...
    await service.handleEvent({
      kind: 'inbox',
      from: 'human',
      to: 'ruben',
      body: 'Peer taskflow: ack',
      sessionId: 'ses_ruben',
      ts: '2026-11-19T10:00:00.000Z',
    });
    expect(real.isCaptureSuppressed('ses_ruben')).toBe(true);
    // ...but the next capture fails OPEN: the real reply is archived.
    await service.handleEvent({
      kind: 'reply',
      from: 'ruben',
      to: null,
      body: 'the real reply',
      sessionId: 'ses_ruben',
      ts: '2026-11-19T10:00:01.000Z',
    });
    const rows = real.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
    expect(rows.map((r) => r.text)).toEqual(['hello', 'the real reply']);
    expect(real.isCaptureSuppressed('ses_ruben')).toBe(false); // retried and cleared
    // Attributed to the observed peer prompt: no boss wake.
    expect(rows.at(-1)).toMatchObject({ to: 'taskflow' });
    expect(opencode.promptCalls.some((c) => c.sessionId === 'ses_boss')).toBe(false);
  });

  it('startup clears every stale arm (no turn survives a restart)', async () => {
    const { service, real } = serviceWithFlakyClear({ count: 0 });
    await service.sendMessage(peerSend({ to: 'taskflow' }));
    expect(real.isCaptureSuppressed('ses_ruben')).toBe(true);
    await service.reconcileDeliveries();
    expect(real.isCaptureSuppressed('ses_ruben')).toBe(false);
  });
});

describe('R9 - authority-looking prefix text is rejected case-insensitively', () => {
  it.each(['Human: x', 'human: x', 'Boss: x', 'boss: x', 'Human : x', 'BOSS :x'])(
    'rejects %s',
    async (message) => {
      const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
      await expect(f.service.sendMessage(peerSend({ message }))).rejects.toMatchObject({
        statusCode: 400,
        code: 'reserved_prefix',
      });
    },
  );
});

describe('R7 - the boss bookmark advances past filtered rows', () => {
  it('peer-only traffic moves the bookmark, so the scan does not grow', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    // A peer-to-peer row: excluded from the slice but not from the bookmark.
    await f.service.handleEvent({
      kind: 'inbox',
      from: 'human',
      to: 'taskflow',
      body: 'Peer ruben: status?',
      sessionId: 'ses_taskflow',
      ts: '2026-11-19T10:00:00.000Z',
    });
    await f.service.handleEvent({
      kind: 'reply',
      from: 'taskflow',
      to: null,
      body: 'green',
      sessionId: 'ses_taskflow',
      ts: '2026-11-19T10:00:01.000Z',
    });
    await f.service.wakeBoss();
    expect(f.store.unread('boss')).toEqual([]);
  });
});
