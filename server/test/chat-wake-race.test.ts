// Chat application — wake-window race (work order Task 1.3): two overlapping
// wakeBoss() calls must not deliver the same unread rows twice (the Nov-16
// greg/porty duplicate; the retired bridge advanced the bookmark AFTER
// prompting, bridge.mjs:119-124). Fix: single-flight wake — a second wake
// call queues behind the in-flight one and RE-CHECKS (coalescing + unread)
// after it completes, instead of racing it. Fakes only — temp dbs, no live
// server, no canonical db.
import { describe, expect, it, vi } from 'vitest';
import { WAKE_PROMPT, composeWakePrompt } from '../src/integrations/opencode/prompts.js';
import { exampleRegistry, makeChatFixture } from './chat-fakes.js';
import type { ChatRegistry, RegistrySnapshot } from '../src/modules/chat/application/ports.js';

/** Registry whose first N read() calls resolve through explicit gates — the
 *  deterministic interleaving control for the two concurrent wake attempts. */
function gatedRegistry(
  snapshot: RegistrySnapshot,
  gates: Array<Promise<RegistrySnapshot>>,
): ChatRegistry {
  const queue = [...gates];
  return { read: async () => queue.shift() ?? snapshot, loadSync: () => snapshot };
}

/** Poll until `probe()` is true (the established fire-and-forget wait pattern). */
async function until(probe: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Seed two slice rows (both addressed to the boss: one named, one legacy
 *  null-receiver) - the Nov-16 duplicate pattern, under the current rule that
 *  the wake carries only boss-addressed traffic. */
function seedRows(fixture: ReturnType<typeof makeChatFixture>): void {
  fixture.store.insert({ ts: '2026-11-17T09:01:00.000Z', from: 'greg', to: 'boss', body: 'greg line', sessionId: null });
  fixture.store.insert({ ts: '2026-11-17T09:02:00.000Z', from: 'porty', to: null, body: 'porty line', sessionId: null });
}

const expectedSlice = composeWakePrompt([
  { time: '2026-11-17T09:01:00.000Z', from: 'greg', to: 'boss', text: 'greg line' },
  { time: '2026-11-17T09:02:00.000Z', from: 'porty', to: null, text: 'porty line' },
]);

describe('single-flight wake (no overlap, no row loss)', () => {
  it('two concurrent wakes deliver the unread slice at most once', async () => {
    const g1 = Promise.resolve<RegistrySnapshot>(exampleRegistry());
    const g2 = Promise.resolve<RegistrySnapshot>(exampleRegistry());
    const f = makeChatFixture(gatedRegistry(exampleRegistry(), [g1, g2]));
    seedRows(f);
    // Hold BOTH wake prompts open (deferred): the first prompt staying
    // mid-flight is what makes the overlap deterministic — without it the
    // second wake's interleaving depends on microtask luck (review fix 5).
    f.opencode.deferPrompts.add('ses_boss');
    const w1 = f.service.wakeBoss();
    const w2 = f.service.wakeBoss();
    // Both attempts are past their registry read; the race window is open.
    await until(() => f.opencode.promptCalls.length >= 1, 'the first wake prompt');
    f.opencode.releasePrompts('ses_boss'); // complete the in-flight prompt
    await Promise.all([w1, w2]);
    // Each row delivered at most once: exactly ONE wake carries the slice.
    // The second wake re-checks and finds nothing unread, so it prompts nobody
    // (an empty wake would be pure noise).
    expect(f.opencode.promptCalls.map((c) => c.text)).toEqual([expectedSlice]);
  });

  it('a failed wake does not consume the rows: the follow-up wake still delivers them', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g1 = Promise.resolve<RegistrySnapshot>(exampleRegistry());
    const g2 = Promise.resolve<RegistrySnapshot>(exampleRegistry());
    const f = makeChatFixture(gatedRegistry(exampleRegistry(), [g1, g2]));
    try {
      seedRows(f);
      // The first wake's prompt parks mid-flight; its LATE ack FAILS (the
      // outcome is read at release). Deterministic both pre-fix (unserialized
      // second wake parks during the failure window) and post-fix (the
      // chained re-check runs after the failure) — review fix 5.
      f.opencode.deferPrompts.add('ses_boss');
      f.opencode.promptOutcome.set('ses_boss', 'unavailable');
      const w1 = f.service.wakeBoss();
      const w2 = f.service.wakeBoss();
      await until(() => f.opencode.promptCalls.length >= 1, 'the first wake prompt');
      f.opencode.releasePrompts('ses_boss'); // the delayed ack FAILS
      await w1; // attempt 1 failed + logged — bookmark untouched
      f.opencode.promptOutcome.delete('ses_boss'); // recovery
      await until(() => f.opencode.promptCalls.length >= 2, 'the follow-up wake prompt');
      f.opencode.releasePrompts('ses_boss'); // the follow-up ack succeeds
      await w2; // the re-check delivers the slice
      expect(f.opencode.promptCalls[1]?.text).toBe(expectedSlice); // rows NOT lost
      expect(f.store.unread('boss')).toEqual([]); // delivered + bookmark advanced once
    } finally {
      errSpy.mockRestore();
    }
  });
});
