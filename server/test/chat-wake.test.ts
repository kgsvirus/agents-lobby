// Chat application — boss wake pins (bridge.mjs:98-130 semantics, retired on
// main in 809440a): BYTE-IDENTICAL slice text, coalescing skip, bookmark-
// advances-only-through-the-slice semantics, empty-slice → bare wake prompt
// with NO bookmark move, and failure isolation — all against the NEW stack.
import { describe, expect, it, vi } from 'vitest';
import { WAKE_PROMPT } from '../src/integrations/opencode/prompts.js';
import { wakeSliceRows } from '../src/modules/chat/domain/message.js';
import { exampleRegistry, fakeRegistry, makeChatFixture } from './chat-fakes.js';

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

describe('wake slice — bridge.mjs:98-130 semantics (retired source; new stack only)', () => {
  it('the slice filter keeps only rows addressed to the boss (plus legacy null receivers)', () => {
    // Rule (2026-11-19): boss replies never ride; NO human row rides; an agent
    // row rides only when it names boss, or is a legacy null-receiver capture.
    const rows = [
      { id: 1, time: 't1', from: 'boss', to: 'human', text: 'own' },
      { id: 2, time: 't2', from: 'human', to: 'boss', text: 'native' },
      { id: 3, time: 't3', from: 'human', to: 'boss ', text: 'still human' },
      { id: 4, time: 't4', from: 'human', to: 'ruben', text: 'private' },
      { id: 5, time: 't5', from: 'human', to: null, text: 'legacy webhook' },
      { id: 6, time: 't6', from: 'taskflow', to: null, text: 'kept' },
      { id: 7, time: 't7', from: 'taskflow', to: 'human', text: 'agent status' },
      { id: 8, time: 't8', from: 'taskflow', to: 'boss', text: 'addressed to boss' },
    ] as const;
    expect(wakeSliceRows([...rows]).map((r) => r.id)).toEqual([5, 6, 8]);
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
      '[2026-11-17T09:02:00.000Z] [from: immigapp] [to: all, boss] broadcast from immigapp',
      '[2026-11-17T09:03:00.000Z] [from: porty] [to: null] webhook capture',
    ].join('\n');
    expect(text).toBe(WAKE_PROMPT + '\n\n' + sliced);
  });

  it('a wake with nothing unread prompts nobody (no empty-slice noise)', async () => {
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    f.store.insert({ ts: '2026-11-17T09:00:00.000Z', from: 'taskflow', to: 'boss', body: 'ping', sessionId: null });
    await f.service.wakeBoss(); // delivers + advances the bookmark
    expect(f.opencode.promptCalls).toHaveLength(1);
    await f.service.wakeBoss(); // nothing new
    expect(f.opencode.promptCalls).toHaveLength(1);
  });

  it('empty slice → the bare wake prompt, and the bookmark advances past the filtered rows', async () => {
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    // Only boss-native rows exist → slice empty.
    f.store.insert({ ts: '2026-11-17T09:00:00.000Z', from: 'human', to: 'boss', body: 'native', sessionId: null });
    f.store.insert({ ts: '2026-11-17T09:00:01.000Z', from: 'boss', to: 'human', body: 'own', sessionId: null });
    await f.service.wakeBoss();
    expect(f.opencode.promptCalls).toEqual([{ sessionId: 'ses_boss', text: WAKE_PROMPT }]);
    // Bookmark rule (peer-messaging fix): advance through the whole unread
    // SNAPSHOT, not just the slice — rows kept out of the slice (boss-native,
    // peer-to-peer) would otherwise be re-read and re-filtered on every wake.
    expect(f.store.unread('boss')).toEqual([]);
    f.store.insert({ ts: '2026-11-17T09:00:02.000Z', from: 'human', to: 'boss', body: 'x', sessionId: null });
    expect(f.store.unread('boss')).toHaveLength(1);
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

  it('the bookmark advances through the unread SNAPSHOT: rows inserted during the enqueue stay unread', async () => {
    const f = makeChatFixture(fakeRegistry(exampleRegistry()));
    seedWakeFixture(f);
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
    // The bookmark is through the snapshot's last row (id 5); the mid-flight
    // row 6 landed after the snapshot and stays unread for the NEXT wake
    // (bridge.mjs:120-124).
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
});
