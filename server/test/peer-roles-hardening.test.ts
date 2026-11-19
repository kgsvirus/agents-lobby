// Hardening pins from the role-policy review.
//
//   H1 an agent may not claim a reserved role (human/boss/all) or an invalid one
//   H2 prototype-named roles deny cleanly instead of throwing
//   H3 a duplicated agent name cannot send (identity is ambiguous)
//   H4 authority senders follow the policy too: a roleless agent is refused,
//      and 'all' skips roleless agents rather than failing the broadcast
//   H5 authority -> 'human' is the legacy no-targets 404, not an empty success
//   H6 reconciliation of a role fan-out row prompts every target once
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonRegistryReader } from '../src/infrastructure/registry/reader.js';
import { isPairAllowed } from '../src/modules/chat/domain/allowlist.js';
import { fakeOpenCode, fakeRegistry, makeChatFixture } from './chat-fakes.js';
import { tempDir } from './helpers.js';

const ALLOWLIST = {
  human: ['boss', 'coordinator', 'developer'],
  boss: ['human', 'coordinator', 'developer'],
  coordinator: ['human', 'boss', 'developer'],
  developer: ['human', 'boss', 'coordinator'],
};

const registry = fakeRegistry({
  serverUrl: null,
  boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
  agents: [
    { name: 'ruben', project: 'TaskFlow', session: 'ses_ruben', role: 'coordinator' },
    { name: 'greg', project: 'TaskFlow', session: 'ses_greg', role: 'coordinator' },
    { name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow', role: 'developer' },
    { name: 'marvin', project: 'ImmigApp', session: 'ses_marvin' },
  ],
});

function registryReader(content: unknown): JsonRegistryReader {
  const file = join(tempDir(), 'agents.json');
  writeFileSync(file, JSON.stringify(content), 'utf8');
  return new JsonRegistryReader(file);
}

const agent = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  project: 'P',
  session: `ses_${name}`,
  ...extra,
});

describe('H1 - registry role validation', () => {
  it.each(['human', 'boss', 'all'])('refuses the reserved role %s', async (role) => {
    await expect(registryReader({ agents: [agent('x', { role })] }).read()).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it.each(['has space', 'UPPER', 'with,comma', 'with:colon'])('refuses the invalid role %s', async (role) => {
    await expect(registryReader({ agents: [agent('x', { role })] }).read()).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it('refuses an agent name with a separator that would break identity', async () => {
    for (const name of ['greg, boss', 'gre g', 'gre:g']) {
      await expect(registryReader({ agents: [agent(name)] }).read()).rejects.toMatchObject({ statusCode: 500 });
    }
  });
});

describe('H2 - prototype-named roles deny cleanly', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('treats %s as unknown', (role) => {
    expect(isPairAllowed(ALLOWLIST, role, 'boss')).toBe(false);
    expect(isPairAllowed(ALLOWLIST, 'human', role)).toBe(false);
  });
});

describe('H3 - an ambiguous sender cannot send', () => {
  it('duplicate names are listed but a send from that name is refused', async () => {
    const twins = fakeRegistry({
      serverUrl: null,
      boss: registry.boss,
      agents: [
        { name: 'ruben', project: 'A', session: 'ses_a', role: 'coordinator' },
        { name: 'ruben', project: 'B', session: 'ses_b', role: 'coordinator' },
      ],
    });
    const f = makeChatFixture(twins, fakeOpenCode(), ALLOWLIST);
    await expect(
      f.service.sendMessage({
        to: 'boss',
        message: 'x',
        from: 'ruben',
        authenticated: true,
        messageId: 'msg_dup',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ambiguous_sender' });
  });
});

describe('H4 - authority senders follow the role policy', () => {
  it('a roleless agent cannot be addressed by name', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await expect(
      f.service.sendMessage({ to: 'marvin', message: 'x', from: 'human', authenticated: true }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'no_role' });
  });

  it('all skips roleless agents instead of failing', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await expect(
      f.service.sendMessage({ to: 'all', message: 'x', from: 'human', authenticated: true }),
    ).resolves.toEqual({ sent: ['ruben', 'greg', 'taskflow'], skipped: [] });
  });
});

describe('H5 - authority -> human is the legacy 404', () => {
  it('returns no_targets rather than an empty success', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await expect(
      f.service.sendMessage({ to: 'human', message: 'x', from: 'boss', authenticated: true }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'no_targets' });
  });
});

describe('H6 - reconciliation of a role fan-out row', () => {
  it('re-prompts every target of the row once', async () => {
    const opencode = fakeOpenCode();
    opencode.promptOutcome.set('ses_ruben', 'unreachable');
    const f = makeChatFixture(registry, opencode, ALLOWLIST);
    const sent = await f.service.sendMessage({
      to: 'coordinator',
      message: 'ready',
      from: 'taskflow',
      authenticated: true,
      messageId: 'msg_fan',
    });
    expect(sent).toEqual({ sent: ['greg'], skipped: ['ruben'], messageId: 'msg_fan' });
    expect(f.store.unconfirmedPeerDeliveries()).toHaveLength(1);

    opencode.promptOutcome.clear();
    const before = opencode.promptCalls.length;
    await f.service.reconcileDeliveries();
    expect(opencode.promptCalls.length).toBe(before + 2); // both coordinators again
    expect(f.store.unconfirmedPeerDeliveries()).toEqual([]);
  });
});
