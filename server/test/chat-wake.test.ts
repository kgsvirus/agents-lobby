// Chat application — boss wake equivalence (bridge.mjs:98-130 port):
// BYTE-IDENTICAL slice text, coalescing skip, bookmark-advances-only-through-
// the-slice semantics, empty-slice → bare wake prompt with NO bookmark move,
// and failure isolation. Fixtures cross-checked against the bridge's own
// source and, for the realistic dataset, against openStore() itself.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WAKE_PROMPT } from '../src/integrations/opencode/prompts.js';
import { wakeSliceRows } from '../src/modules/chat/domain/message.js';
import { openDatabase, runMigrations, migrationsFolder } from '../src/infrastructure/database/client.js';
import { EventBus } from '../src/infrastructure/events/bus.js';
import { ChatMessageRepository } from '../src/modules/chat/infrastructure/message-repository.js';
import { ChatService } from '../src/modules/chat/application/chat-service.js';
import { exampleRegistry, fakeOpenCode, fakeRegistry, makeChatFixture } from './chat-fakes.js';
import { tempDir } from './helpers.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const { openStore } = require('../../store.mjs') as {
  openStore: (file?: string) => {
    insert: (row: { ts: string; from: string; to: string | null; body: string }) => { id: number };
    unread: (consumer?: string) => Array<{ id: number; time: string; from: string; to: string | null; text: string }>;
    markSeen: (consumer?: string, throughId?: number) => void;
    close: () => void;
  };
};

const canonicalCopyPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.data', 'verify-copy.db');

/** Rows that exercise every slice filter (fixture derived from bridge.mjs's
 *  wakeBoss filter: exclude from === 'boss', exclude human → boss). */
function seedWakeFixture(fixture: ReturnType<typeof makeChatFixture>): void {
  const rows: Array<[string, string, string | null, string]> = [
    // id 1: human → boss — natively in the boss session → EXCLUDED
    ['2026-11-17T09:00:00.000Z', 'human', 'boss', 'in-session prompt'],
    // id 2: boss's own reply — natively in the boss session → EXCLUDED
    ['2026-11-17T09:00:05.000Z', 'boss', 'human', 'my reply'],
    // id 3: agent → human — belongs in the slice
    ['2026-11-17T09:01:00.000Z', 'taskflow', 'human', 'agent status: phase done'],
    // id 4: agent → comma-list containing… not boss — belongs in the slice
    ['2026-11-17T09:02:00.000Z', 'immigapp', 'all, boss', 'broadcast from immigapp'],
    // id 5: legacy webhook row with NULL receiver — belongs in the slice
    ['2026-11-17T09:03:00.000Z', 'porty', null, 'webhook capture'],
  ];
  for (const [ts, from, to, body] of rows) {
    fixture.store.insert({ ts, from, to, body, sessionId: null });
  }
}

describe('wake slice — byte-identical with bridge.mjs (bridge.mjs:98-130)', () => {
  it('the slice filter excludes exactly what the bridge excludes (transcribed from source)', () => {
    // bridge.mjs:113 verbatim filter logic: from !== 'boss' && !(from === 'human' && to === 'boss')
    const source = readFileSync(fileURLToPath(new URL('../../bridge.mjs', import.meta.url)), 'utf8');
    expect(source).toContain(".filter((r) => r.from !== \"boss\" && !(r.from === \"human\" && r.to === \"boss\"))");
    const rows = [
      { id: 1, time: 't1', from: 'boss', to: 'human', text: 'own' },
      { id: 2, time: 't2', from: 'human', to: 'boss', text: 'native' },
      { id: 3, time: 't3', from: 'human', to: 'boss ', text: 'kept (exact match only)' },
      { id: 4, time: 't4', from: 'taskflow', to: null, text: 'kept' },
    ] as const;
    expect(wakeSliceRows([...rows]).map((r) => r.id)).toEqual([3, 4]);
  });

  it('wakes with a BYTE-IDENTICAL slice text for the fixture rows', async () => {
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    seedWakeFixture(f);
    await f.service.wakeBoss();
    expect(f.opencode.promptCalls).toHaveLength(1);
    const text = f.opencode.promptCalls[0]?.text ?? '';
    // Built with the bridge's exact template (bridge.mjs:114-118):
    // WAKE_PROMPT + "\n\n" + rows.map(r => `[${r.time}] [from: ${r.from}] [to: ${r.to}] ${r.text}`).join("\n")
    const sliced = [
      '[2026-11-17T09:01:00.000Z] [from: taskflow] [to: human] agent status: phase done',
      '[2026-11-17T09:02:00.000Z] [from: immigapp] [to: all, boss] broadcast from immigapp',
      '[2026-11-17T09:03:00.000Z] [from: porty] [to: null] webhook capture',
    ].join('\n');
    expect(text).toBe(WAKE_PROMPT + '\n\n' + sliced);
  });

  it('empty slice → the bare wake prompt and NO bookmark move (bridge.mjs:118,121-124)', async () => {
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    // Only boss-native rows exist → slice empty.
    f.store.insert({ ts: '2026-11-17T09:00:00.000Z', from: 'human', to: 'boss', body: 'native', sessionId: null });
    f.store.insert({ ts: '2026-11-17T09:00:01.000Z', from: 'boss', to: 'human', body: 'own', sessionId: null });
    await f.service.wakeBoss();
    expect(f.opencode.promptCalls).toEqual([{ sessionId: 'ses_boss', text: WAKE_PROMPT }]);
    // No bookmark move: everything (rows 1, 2) still counts as unread.
    expect(f.store.unread('boss').map((r) => r.id)).toEqual([1, 2]);
    f.store.insert({ ts: '2026-11-17T09:00:02.000Z', from: 'human', to: 'boss', body: 'x', sessionId: null });
    expect(f.store.unread('boss')).toHaveLength(3);
  });

  it('skips the wake entirely when a user input is already pending (coalescing, bridge.mjs:102-106)', async () => {
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    seedWakeFixture(f);
    f.opencode.pendingInput.set('ses_boss', true);
    await f.service.wakeBoss();
    expect(f.opencode.promptCalls).toEqual([]);
    // …and the bookmark did NOT advance — the next wake still carries the slice.
    expect(f.store.unread('boss')).toHaveLength(5);
  });

  it('the bookmark advances only THROUGH the slice: rows inserted during the enqueue stay unread', async () => {
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    seedWakeFixture(f);
    // Simulate a row landing between the unread snapshot and the bookmark
    // write (the await gap the bridge comments on, bridge.mjs:120-123).
    // Simulate a row landing between the unread snapshot and the bookmark
    // write (the await gap the bridge comments on, bridge.mjs:120-123).
    const store = f.store;
    const prompts = f.opencode.integration.prompts;
    const realPrompt = prompts.prompt.bind(prompts);
    prompts.prompt = async (sessionId: string, text: string) => {
      store.insert({ ts: '2026-11-17T09:04:00.000Z', from: 'taskflow', to: 'human', body: 'arrived during enqueue', sessionId: null });
      await realPrompt(sessionId, text);
    };
    await f.service.wakeBoss();
    expect(f.opencode.promptCalls).toHaveLength(1);
    // Bookmark is through the slice's last row (id 5) — the mid-flight row 6
    // stays unread and surfaces in the NEXT wake (bridge.mjs:120-124).
    expect(f.store.unread('boss').map((r) => r.id)).toEqual([6]);
  });

  it('prompt failure → logged, no bookmark move, no throw (bridge.mjs:127-129)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    seedWakeFixture(f);
    f.opencode.promptOutcome.set('ses_boss', 'unavailable');
    await expect(f.service.wakeBoss()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    expect(f.store.unread('boss')).toHaveLength(5); // bookmark untouched
    errSpy.mockRestore();
  });

  it('no effective server URL → wake is skipped with the bridge log, no inbox check (bridge.mjs:99-100)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    seedWakeFixture(f);
    f.opencode.available = false;
    await expect(f.service.wakeBoss()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith('[chat] No OpenCode server URL; cannot wake boss.');
    expect(f.opencode.promptCalls).toEqual([]);
    expect(f.store.unread('boss')).toHaveLength(5); // bookmark untouched
    errSpy.mockRestore();
  });

  it('no boss configured (fresh clone) → wake is a no-op', async () => {
    const f = makeChatFixture(fakeRegistry({ serverUrl: null, boss: null, agents: [] }));
    f.store.insert({ ts: '2026-11-17T09:00:00.000Z', from: 'taskflow', to: 'human', body: 'x', sessionId: null });
    await f.service.wakeBoss();
    expect(f.opencode.promptCalls).toEqual([]);
  });

  it.skipIf(!existsSync(canonicalCopyPath))(
    'the slice text over the canonical copy equals the bridge computation over openStore()',
    async () => {
      const dir = tempDir();
      const copyPath = join(dir, 'wake-copy.db');
      copyFileSync(canonicalCopyPath, copyPath); // checked-in copy is never mutated
      // Seed fresh unread rows the way the bridge listener would: an agent →
      // boss reply and an agent → all broadcast. The canonical copy's unread
      // state is whatever the live db last had (bookmark advances with real
      // wakes) — captured here, not hardcoded, so the equivalence holds for
      // any snapshot of production data.
      const legacy = openStore(copyPath);
      legacy.insert({ ts: '2026-11-17T10:00:00.000Z', from: 'ruben', to: 'boss', body: 'newest reply' });
      legacy.insert({ ts: '2026-11-17T10:00:05.000Z', from: 'greg', to: 'all', body: 'greg broadcast' });
      const expectedRows = legacy.unread('boss').filter(
        (r) => r.from !== 'boss' && !(r.from === 'human' && r.to === 'boss'),
      );
      const expectedText =
        WAKE_PROMPT +
        '\n\n' +
        expectedRows.map((r) => `[${r.time}] [from: ${r.from}] [to: ${r.to}] ${r.text}`).join('\n');
      legacy.close();

      // The chat stack over the SAME file (migrations no-op on the legacy schema).
      const { db, sqlite } = openDatabase(copyPath);
      runMigrations(db, migrationsFolder());
      const bus = new EventBus(sqlite);
      const store = new ChatMessageRepository(sqlite);
      const opencode = fakeOpenCode();
      const service = new ChatService({
        store,
        registry: fakeRegistry(exampleRegistry()),
        ports: { prompts: opencode.integration.prompts, sessions: opencode.integration.sessions, bus },
      });
      await service.wakeBoss();
      expect(opencode.promptCalls).toEqual([
        { sessionId: 'ses_boss', text: expectedText },
      ]);
      // …and the bookmark advanced through the slice exactly as the bridge's.
      expect(store.unread('boss')).toEqual([]);
    },
  );
});
