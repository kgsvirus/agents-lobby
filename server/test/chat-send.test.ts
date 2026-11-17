// Chat application — /send fan-out equivalence (bridge.mjs:390-443 port):
// target resolution (all / name / array), per-target prompt with the
// Human:/Boss: prefix, Promise.allSettled sent/skipped accounting, the saved
// row's `to` = joined SUCCESSFUL targets, and error isolation. Fake prompt
// port — no live server.
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/shared/errors/index.js';
import { exampleRegistry, fakeOpenCode, fakeRegistry, makeChatFixture } from './chat-fakes.js';
import type { WireMessage } from '../src/shared/schemas/wire.js';

const registry = fakeRegistry(exampleRegistry());

function savedRows(fixture: ReturnType<typeof makeChatFixture>): WireMessage[] {
  return fixture.store.query({ view: 'all', after: 0, before: 0, limit: 1000, agents: [] }).rows as WireMessage[];
}

describe('ChatService.sendMessage — fan-out (bridge.mjs:390-443)', () => {
  it('to=all prompts every registry agent with the Boss: prefix and saves the row', async () => {
    const f = makeChatFixture(registry);
    const result = await f.service.sendMessage({ to: 'all', message: 'status update' });
    expect(result).toEqual({ sent: ['taskflow', 'immigapp'], skipped: [] });
    expect(f.opencode.promptCalls).toEqual([
      { sessionId: 'ses_taskflow', text: 'Boss: status update' },
      { sessionId: 'ses_immigapp', text: 'Boss: status update' },
    ]);
    expect(savedRows(f)).toEqual([
      { id: 1, time: savedRows(f)[0]?.time ?? '', from: 'boss', to: 'taskflow, immigapp', text: 'status update' },
    ]);
  });

  it('from=human uses the Human: prefix', async () => {
    const f = makeChatFixture(registry);
    await f.service.sendMessage({ to: 'immigapp', message: 'hi', from: 'human' });
    expect(f.opencode.promptCalls).toEqual([{ sessionId: 'ses_immigapp', text: 'Human: hi' }]);
    expect(savedRows(f)[0]?.to).toBe('immigapp');
  });

  it('from defaults to boss (bridge.mjs:394)', async () => {
    const f = makeChatFixture(registry);
    await f.service.sendMessage({ to: 'immigapp', message: 'hi' });
    expect(f.opencode.promptCalls[0]?.text).toBe('Boss: hi');
  });

  it('to=array prompts only the listed agents, in REGISTRY order (bridge.mjs:405-408)', async () => {
    const f = makeChatFixture(registry);
    const result = await f.service.sendMessage({ to: ['immigapp', 'taskflow'], message: 'x' });
    expect(result).toEqual({ sent: ['taskflow', 'immigapp'], skipped: [] });
    expect(f.opencode.promptCalls.map((c) => c.sessionId)).toEqual(['ses_taskflow', 'ses_immigapp']);
  });

  it('DUPLICATE agent names: target resolution matches ALL entries — both sessions prompted, name repeated in sent (bridge.mjs:404-408,420-424 map the whole array)', async () => {
    const twins = fakeRegistry({
      serverUrl: null,
      boss: null,
      agents: [
        { name: 'twins', project: 'One', session: 'ses_t1' },
        { name: 'twins', project: 'Two', session: 'ses_t2' },
      ],
    });
    const f = makeChatFixture(twins);
    const result = await f.service.sendMessage({ to: 'twins', message: 'x' });
    expect(result).toEqual({ sent: ['twins', 'twins'], skipped: [] });
    expect(f.opencode.promptCalls.map((c) => c.sessionId)).toEqual(['ses_t1', 'ses_t2']);
    expect(savedRows(f)[0]?.to).toBe('twins, twins');
  });

  it('404 when no target matches (name or array, bridge.mjs:409-412)', async () => {
    const f = makeChatFixture(registry);
    await expect(f.service.sendMessage({ to: 'nobody', message: 'x' })).rejects.toMatchObject({
      name: 'AppError', statusCode: 404, code: 'no_targets', message: 'no matching agents for: "nobody"',
    });
    await expect(f.service.sendMessage({ to: ['nobody'], message: 'x' })).rejects.toBeInstanceOf(AppError);
    expect(f.opencode.promptCalls).toEqual([]); // nothing attempted, nothing saved
  });

  it('400 on empty message (after trim) and on a non human|boss sender, in bridge order', async () => {
    const f = makeChatFixture(registry);
    await expect(f.service.sendMessage({ to: 'all', message: '   ' })).rejects.toMatchObject({
      statusCode: 400, code: 'invalid_input', message: 'message is required',
    });
    await expect(f.service.sendMessage({ to: 'all', message: 'x', from: 'marvin' })).rejects.toMatchObject({
      statusCode: 400, code: 'invalid_sender', message: "from must be 'human' or 'boss'",
    });
    expect(f.opencode.promptCalls).toEqual([]);
  });

  it('partial failure: sent/skipped split, row saved with joined SUCCESSFUL targets only', async () => {
    const f = makeChatFixture(registry);
    f.opencode.promptOutcome.set('ses_immigapp', 'upstream-error'); // target 2 fails
    const result = await f.service.sendMessage({ to: 'all', message: 'x' });
    expect(result).toEqual({ sent: ['taskflow'], skipped: ['immigapp'] });
    expect(savedRows(f)[0]?.to).toBe('taskflow'); // NOT the requested 'all'
  });

  it('all targets fail → no row saved at all (bridge.mjs:427)', async () => {
    const f = makeChatFixture(registry);
    f.opencode.promptOutcome.set('ses_taskflow', 'unavailable');
    f.opencode.promptOutcome.set('ses_immigapp', 'unavailable');
    const result = await f.service.sendMessage({ to: 'all', message: 'x' });
    expect(result).toEqual({ sent: [], skipped: ['taskflow', 'immigapp'] });
    expect(savedRows(f)).toEqual([]);
  });

  it('records lastPromptFrom per target even when that target fails', async () => {
    const f = makeChatFixture(registry);
    f.opencode.promptOutcome.set('ses_taskflow', 'timeout');
    await f.service.sendMessage({ to: 'all', message: 'x', from: 'human' });
    await f.service.handleEvent({
      kind: 'reply', from: 'taskflow', to: null, body: 'late', sessionId: 'ses_taskflow', ts: '2026-11-17T10:00:00.000Z',
    });
    expect(savedRows(f).at(-1)?.to).toBe('human');
  });
});
