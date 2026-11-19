// Chat application - observed-inbound attribution + peer capture/wake rules.
//
// Attribution is set when the lobby's own prompt is OBSERVED arriving on the
// target session, not when the send is enqueued. A peer send's delivery turn
// is transcript (already archived byte-for-byte), so its text.ended is not a
// second message, and a peer-to-peer reply never wakes the boss.
import { describe, expect, it } from 'vitest';
import { WAKE_PROMPT } from '../src/integrations/opencode/prompts.js';
import { fakeOpenCode, fakeRegistry, makeChatFixture } from './chat-fakes.js';
import type { WireMessage } from '../src/shared/schemas/wire.js';

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
    { name: 'taskflow', project: 'TaskFlow', session: 'ses_taskflow', role: 'developer' },
  ],
});

type Fixture = ReturnType<typeof makeChatFixture>;

function rows(f: Fixture): WireMessage[] {
  return f.store.query({ view: 'all', after: 0, before: 0, limit: 500, agents: [] }).rows as WireMessage[];
}

const inbox = (to: string, body: string, sessionId: string) =>
  ({ kind: 'inbox', from: 'human', to, body, sessionId, ts: '2026-11-19T10:00:00.000Z' }) as const;

const reply = (from: string, body: string, sessionId: string) =>
  ({ kind: 'reply', from, to: null, body, sessionId, ts: '2026-11-19T10:00:05.000Z' }) as const;

describe('observed-inbound attribution', () => {
  it('attributes the reply to the sender of the prompt actually observed for that session', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.handleEvent(inbox('ruben', 'Peer taskflow: ping', 'ses_ruben'));
    await f.service.handleEvent(reply('ruben', 'pong', 'ses_ruben'));
    expect(rows(f).map((r) => [r.from, r.to, r.text])).toEqual([['ruben', 'taskflow', 'pong']]);
  });

  it('a later enqueue does not overwrite the prompt being answered', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    // ruben was prompted by taskflow; then boss prompts ruben while the first
    // prompt is still queued (only enqueued, not observed).
    await f.service.sendMessage({ to: 'ruben', message: 'from boss' });
    await f.service.handleEvent(inbox('ruben', 'Peer taskflow: ping', 'ses_ruben'));
    await f.service.handleEvent(reply('ruben', 'pong', 'ses_ruben'));
    // The boss-send row is the archive of the enqueue; the reply is last.
    expect(rows(f).at(-1)).toMatchObject({ from: 'ruben', to: 'taskflow', text: 'pong' });
  });

  it('an unprefixed inbound (direct OpenCode prompt) drops the stale pending sender', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    // A peer prompt is observed, then that turn produces no captured reply
    // (interrupt/error), then someone prompts the session directly.
    await f.service.handleEvent(inbox('ruben', 'Peer taskflow: ping', 'ses_ruben'));
    await f.service.handleEvent(inbox('ruben', 'raw text from a direct prompt', 'ses_ruben'));
    await f.service.handleEvent(reply('ruben', 'answer', 'ses_ruben'));
    // Fails toward boss, never toward the stale peer.
    expect(rows(f).at(-1)).toMatchObject({ from: 'ruben', to: 'boss' });
  });

  it('is single-use: the next unanswered reply falls back to boss', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.handleEvent(inbox('ruben', 'Peer taskflow: ping', 'ses_ruben'));
    await f.service.handleEvent(reply('ruben', 'one', 'ses_ruben'));
    await f.service.handleEvent(reply('ruben', 'two', 'ses_ruben'));
    expect(rows(f).map((r) => [r.text, r.to])).toEqual([
      ['one', 'taskflow'],
      ['two', 'boss'],
    ]);
  });
});

describe('peer delivery-turn suppression', () => {
  it('does not archive the sender turn transcript as a second message', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    const sent = await f.service.sendMessage({
      to: 'taskflow',
      message: 'hello',
      from: 'ruben',
      authenticated: true,
      messageId: 'msg_1',
    });
    expect(sent.sent).toEqual(['taskflow']);
    // The delivery turn ends: its transcript must be skipped.
    await f.service.handleEvent(reply('ruben', 'Sent it.', 'ses_ruben'));
    expect(rows(f).map((r) => [r.from, r.text])).toEqual([['ruben', 'hello']]);
  });

  it('archives the next turn after the session received a new inbound prompt', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.sendMessage({
      to: 'taskflow',
      message: 'hello',
      from: 'ruben',
      authenticated: true,
      messageId: 'msg_1',
    });
    await f.service.handleEvent(reply('ruben', 'Sent it.', 'ses_ruben')); // suppressed
    await f.service.handleEvent(inbox('ruben', 'Peer taskflow: thanks', 'ses_ruben')); // clears arming
    await f.service.handleEvent(reply('ruben', 'welcome', 'ses_ruben')); // archived
    expect(rows(f).map((r) => [r.text, r.to])).toEqual([
      ['hello', 'taskflow'],
      ['welcome', 'taskflow'],
    ]);
  });

  it('suppresses the first text of the delivery turn; later segments archive as noise', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.sendMessage({
      to: 'taskflow',
      message: 'hello',
      from: 'ruben',
      authenticated: true,
      messageId: 'msg_1',
    });
    await f.service.handleEvent(reply('ruben', 'first segment', 'ses_ruben')); // suppressed
    await f.service.handleEvent(reply('ruben', 'second segment', 'ses_ruben')); // archived
    // Consume-once is deliberate: holding the arm for the whole turn depends on
    // a turn-boundary event the stream does not provide, and a lingering arm
    // can suppress a REAL reply. A duplicate transcript row is the lesser cost.
    expect(rows(f).map((r) => r.text)).toEqual(['hello', 'second segment']);
  });
});

describe('peer -> human delivery (intended: UI-only)', () => {
  it('archives the message and wakes nobody', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    const result = await f.service.sendMessage({
      to: 'human',
      message: 'status for the human',
      from: 'ruben',
      authenticated: true,
      messageId: 'msg_h',
    });
    expect(result).toEqual({ sent: ['human'], skipped: [], messageId: 'msg_h' });
    await new Promise((r) => setTimeout(r, 5));
    // Ruling: a peer->human message is archived and shown live in the UI. It
    // does NOT wake Boss - waking Boss is the relay cost this feature removes.
    // The row still rides a LATER wake slice (it addresses `human`).
    expect(f.opencode.promptCalls).toEqual([]);
    expect(rows(f).map((r) => [r.from, r.to])).toEqual([['ruben', 'human']]);
  });
});

describe('wake boundary', () => {
  it('a peer-to-peer reply does not wake boss', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.handleEvent(inbox('taskflow', 'Peer ruben: status?', 'ses_taskflow'));
    await f.service.handleEvent(reply('taskflow', 'green', 'ses_taskflow'));
    await new Promise((r) => setTimeout(r, 5));
    expect(f.opencode.promptCalls.filter((c) => c.sessionId === 'ses_boss')).toEqual([]);
    expect(rows(f).map((r) => [r.from, r.to])).toEqual([['taskflow', 'ruben']]);
  });

  it('a reply addressed to the human does not wake boss (its row never rides the slice)', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.handleEvent(inbox('ruben', 'Human: status?', 'ses_ruben'));
    await f.service.handleEvent(reply('ruben', 'all good', 'ses_ruben'));
    await new Promise((r) => setTimeout(r, 5));
    expect(f.opencode.promptCalls.filter((c) => c.sessionId === 'ses_boss')).toEqual([]);
    expect(rows(f).at(-1)).toMatchObject({ from: 'ruben', to: 'human' });
  });

  it('a reply addressed to boss still wakes boss and rides the slice', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.handleEvent(inbox('taskflow', 'Boss: status?', 'ses_taskflow'));
    await f.service.handleEvent(reply('taskflow', 'green', 'ses_taskflow'));
    await new Promise((r) => setTimeout(r, 5));
    const wakes = f.opencode.promptCalls.filter((c) => c.sessionId === 'ses_boss');
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toBe(`${WAKE_PROMPT}\n\n[2026-11-19T10:00:05.000Z] [from: taskflow] [to: boss] green`);
  });

  it('a peer-to-peer row is excluded from a later slice that also carries boss traffic', async () => {
    const f = makeChatFixture(registry, fakeOpenCode(), ALLOWLIST);
    await f.service.handleEvent(inbox('taskflow', 'Peer ruben: status?', 'ses_taskflow'));
    await f.service.handleEvent(reply('taskflow', 'peer answer', 'ses_taskflow'));
    await f.service.handleEvent(inbox('ruben', 'Boss: report', 'ses_ruben'));
    await f.service.handleEvent(reply('ruben', 'boss answer', 'ses_ruben'));
    await new Promise((r) => setTimeout(r, 5));
    const text = f.opencode.promptCalls.filter((c) => c.sessionId === 'ses_boss').at(-1)?.text ?? '';
    expect(text).toContain('boss answer');
    expect(text).not.toContain('peer answer');
  });
});
