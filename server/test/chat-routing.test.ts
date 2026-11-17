// Chat application — message routing equivalence (bridge.mjs:137-212 port):
// boss-only filter, echo suppression (exact + prefix semantics), reply routing
// via lastPromptFrom with the "boss" fallback, and the atomic ingest (message
// row + message.created bus event commit together). Fakes only — no live
// OpenCode server, no canonical db.
import { describe, expect, it } from 'vitest';
import { WAKE_PROMPT } from '../src/integrations/opencode/prompts.js';
import type { WireMessage } from '../src/shared/schemas/wire.js';
import { exampleRegistry, fakeOpenCode, fakeRegistry, makeChatFixture } from './chat-fakes.js';

const registry = fakeRegistry(exampleRegistry());

function savedRows(fixture: ReturnType<typeof makeChatFixture>): WireMessage[] {
  return fixture.store.query({ view: 'all', after: 0, before: 0, limit: 1000, agents: [] }).rows as WireMessage[];
}

describe('ChatService.handleEvent — capture policy (bridge.mjs:166-204)', () => {
  it('saves boss inbox items as human → boss (genuine human input)', async () => {
    const f = makeChatFixture(registry);
    await f.service.handleEvent({
      kind: 'inbox', from: 'human', to: 'boss', body: 'hello boss', sessionId: 'ses_boss', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f)).toEqual([
      { id: 1, time: '2026-11-17T10:00:00.000Z', from: 'human', to: 'boss', text: 'hello boss' },
    ]);
  });

  it('drops inbox items for agent sessions (boss-only filter, bridge.mjs:172-174)', async () => {
    const f = makeChatFixture(registry);
    await f.service.handleEvent({
      kind: 'inbox', from: 'human', to: 'taskflow', body: 'human typed into an agent session', sessionId: 'ses_taskflow', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f)).toEqual([]);
    expect(f.opencode.promptCalls).toEqual([]); // no wake for filtered items
  });

  it('suppresses the wake-prompt echo (EXACT equality, bridge.mjs:176)', async () => {
    const f = makeChatFixture(registry);
    await f.service.handleEvent({
      kind: 'inbox', from: 'human', to: 'boss', body: WAKE_PROMPT, sessionId: 'ses_boss', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f)).toEqual([]);
  });

  it('suppresses the wake-prompt echo carrying the unread slice (prefix + \\n\\n, bridge.mjs:177)', async () => {
    const f = makeChatFixture(registry);
    await f.service.handleEvent({
      kind: 'inbox', from: 'human', to: 'boss', body: WAKE_PROMPT + '\n\n[2026-11-17T10:00:00.000Z] [from: taskflow] [to: boss] done', sessionId: 'ses_boss', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f)).toEqual([]);
  });

  it('captures a REAL message that merely begins with the wake text (bridge.mjs:171 comment)', async () => {
    const f = makeChatFixture(registry);
    await f.service.handleEvent({
      kind: 'inbox', from: 'human', to: 'boss', body: '[message received] and more text', sessionId: 'ses_boss', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f).map((r) => r.text)).toEqual(['[message received] and more text']);
  });

  it('routes boss replies to human (bridge.mjs:187-193)', async () => {
    const f = makeChatFixture(registry);
    await f.service.handleEvent({
      kind: 'reply', from: 'boss', to: null, body: 'boss says hi', sessionId: 'ses_boss', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f)).toEqual([
      { id: 1, time: '2026-11-17T10:00:00.000Z', from: 'boss', to: 'human', text: 'boss says hi' },
    ]);
  });

  it('routes agent replies to the last prompter; default boss fallback (bridge.mjs:195)', async () => {
    const f = makeChatFixture(registry);
    await f.service.handleEvent({
      kind: 'reply', from: 'taskflow', to: null, body: 'agent reply', sessionId: 'ses_taskflow', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f)).toEqual([
      { id: 1, time: '2026-11-17T10:00:00.000Z', from: 'taskflow', to: 'boss', text: 'agent reply' },
    ]);
  });

  it('routes an agent reply to the recorded /send sender (lastPromptFrom)', async () => {
    const f = makeChatFixture(registry);
    await f.service.sendMessage({ to: 'taskflow', message: 'do the thing', from: 'human' });
    await f.service.handleEvent({
      kind: 'reply', from: 'taskflow', to: null, body: 'done', sessionId: 'ses_taskflow', ts: '2026-11-17T10:01:00.000Z',
    });
    expect(savedRows(f).map((r) => [r.from, r.to, r.text])).toEqual([
      ['human', 'taskflow', 'do the thing'],
      ['taskflow', 'human', 'done'],
    ]);
  });

  it('records lastPromptFrom BEFORE the prompt resolves (reply may race the send, bridge.mjs:416)', async () => {
    const f = makeChatFixture(registry);
    f.opencode.holdPrompts.add('ses_taskflow'); // prompt never resolves
    const send = f.service.sendMessage({ to: 'taskflow', message: 'go', from: 'human' });
    // Flush microtasks so the send's registry read + lastPromptFrom recording
    // have happened, while the prompt itself is still held open.
    await new Promise((r) => setTimeout(r, 0));
    // The reply event arrives while the prompt is still in flight.
    await f.service.handleEvent({
      kind: 'reply', from: 'taskflow', to: null, body: 'early reply', sessionId: 'ses_taskflow', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f).map((r) => [r.from, r.to])).toEqual([['taskflow', 'human']]);
    // The send itself stays pending (held prompt) — the recording happened
    // before the prompt could resolve, which is the whole point of the test.
  });

  it('wakes the boss after an agent reply — the slice carries the reply line (bridge.mjs:111-118)', async () => {
    const f = makeChatFixture(registry);
    await f.service.handleEvent({
      kind: 'reply', from: 'taskflow', to: null, body: 'reply', sessionId: 'ses_taskflow', ts: '2026-11-17T10:00:00.000Z',
    });
    // give the fire-and-forget wake a tick to run
    await new Promise((r) => setTimeout(r, 5));
    expect(f.opencode.promptCalls).toHaveLength(1);
    expect(f.opencode.promptCalls[0]?.sessionId).toBe('ses_boss');
    // The agent's reply (taskflow → boss) is NOT natively in the boss session,
    // so it rides in the wake slice — exactly the bridge's behavior.
    expect(f.opencode.promptCalls[0]?.text).toBe(
      WAKE_PROMPT + '\n\n[2026-11-17T10:00:00.000Z] [from: taskflow] [to: boss] reply',
    );
  });

  it('ingests atomically: the message.created event carries the wire row and fires only after commit', async () => {
    const f = makeChatFixture(registry);
    const events: unknown[] = [];
    f.bus.subscribe((e) => events.push(e));
    await f.service.handleEvent({
      kind: 'inbox', from: 'human', to: 'boss', body: 'atomic', sessionId: 'ses_boss', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(events[0]).toMatchObject({
      id: 1,
      type: 'message.created',
      payload: { id: 1, time: '2026-11-17T10:00:00.000Z', from: 'human', to: 'boss', text: 'atomic' },
    });
    // The persisted row is readable through the same store (same transaction).
    expect(savedRows(f)).toHaveLength(1);
  });
});
