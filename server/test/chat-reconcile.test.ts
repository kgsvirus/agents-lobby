// Startup delivery reconciliation: a peer row archived but never confirmed is
// re-prompted once (at-least-once), then never again.
import { describe, expect, it } from 'vitest';
import { fakeOpenCode, fakeRegistry, makeChatFixture } from './chat-fakes.js';

const registry = fakeRegistry({
  serverUrl: null,
  boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
  agents: [{ name: 'ruben', project: 'TaskFlow', session: 'ses_ruben', role: 'coordinator' }],
});

const ALLOWLIST = { coordinator: ['human', 'boss'] };

describe('reconcileDeliveries', () => {
  it('re-prompts an unconfirmed row once and marks it, never twice', async () => {
    const opencode = fakeOpenCode();
    opencode.promptOutcome.set('ses_boss', 'unreachable');
    const f = makeChatFixture(registry, opencode, ALLOWLIST);
    const sent = await f.service.sendMessage({
      to: 'boss',
      message: 'hello',
      from: 'ruben',
      authenticated: true,
      messageId: 'msg_1',
    });
    expect(sent).toEqual({ sent: [], skipped: ['boss'], messageId: 'msg_1' });
    expect(f.store.unconfirmedPeerDeliveries()).toHaveLength(1);

    // The upstream recovers; startup reconciliation delivers it.
    opencode.promptOutcome.delete('ses_boss');
    await f.service.reconcileDeliveries();
    expect(opencode.promptCalls.at(-1)).toEqual({ sessionId: 'ses_boss', text: 'Peer ruben: hello' });
    expect(f.store.unconfirmedPeerDeliveries()).toEqual([]);

    // A second pass (same process or next start) prompts nothing.
    const before = opencode.promptCalls.length;
    await f.service.reconcileDeliveries();
    expect(opencode.promptCalls).toHaveLength(before);
  });

  it('gives up on a row whose recipient is gone, without throwing', async () => {
    const opencode = fakeOpenCode();
    const f = makeChatFixture(fakeRegistry({ serverUrl: null, boss: registry.boss, agents: [] }), opencode, ALLOWLIST);
    // Archive a pending row directly (recipient not in the registry).
    f.store.insert({
      ts: '2026-11-19T10:00:00.000Z',
      from: 'ruben',
      to: 'ghost',
      body: 'lost',
      sessionId: 'ses_ruben',
      messageId: 'msg_2',
      deliveryState: 0,
    });
    await expect(f.service.reconcileDeliveries()).resolves.toBeUndefined();
    expect(opencode.promptCalls).toEqual([]);
    expect(f.store.unconfirmedPeerDeliveries()).toEqual([]);
  });

  it('does nothing when every row is confirmed', async () => {
    const opencode = fakeOpenCode();
    const f = makeChatFixture(registry, opencode, ALLOWLIST);
    await f.service.sendMessage({
      to: 'boss',
      message: 'hello',
      from: 'ruben',
      authenticated: true,
      messageId: 'msg_1',
    });
    const before = opencode.promptCalls.length;
    await f.service.reconcileDeliveries();
    expect(opencode.promptCalls).toHaveLength(before);
  });
});
