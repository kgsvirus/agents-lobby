// Alignment rule (legacy MessageBubble.tsx): Human (the current user) floats
// right in EVERY view; agents and the boss float left. Sender label sits
// above the bubble. Time rendering depends on the machine timezone, so meta
// strings are asserted on structure rather than a literal hh:mm.
import { describe, expect, it } from 'vitest';
import { Message, bubbleMeta } from '../src/lib/api';

const msg = (id: number, from: string, to: string | null): Message => ({
  id,
  time: '2026-11-17T10:00:00.000Z',
  from,
  to,
  text: '',
});

const time = new Date(msg(1, 'boss', null).time).toTimeString().slice(0, 5);

describe('bubbleMeta', () => {
  it('human floats right in every view', () => {
    expect(bubbleMeta(msg(1, 'human', 'taskflow'), false).right).toBe(true);
    expect(bubbleMeta(msg(1, 'human', null), true).right).toBe(true);
  });

  it('agents and boss float left', () => {
    expect(bubbleMeta(msg(1, 'boss', 'human'), false).right).toBe(false);
    expect(bubbleMeta(msg(2, 'taskflow', 'boss'), false).right).toBe(false);
  });

  it('agent-directed traffic carries direction in every view', () => {
    expect(bubbleMeta(msg(1, 'taskflow', 'boss'), false).meta).toBe(`taskflow → boss · ${time}`);
    expect(bubbleMeta(msg(2, 'human', 'taskflow'), false).meta).toBe(`${time} · taskflow ← human`);
  });

  it('non-directional views (Boss) keep the plain sender · time label for the human channel', () => {
    expect(bubbleMeta(msg(1, 'boss', 'human'), false).meta).toBe(`Boss · ${time}`);
    expect(bubbleMeta(msg(2, 'human', null), false).meta).toBe(`Human · ${time}`);
  });

  it('human prompts to boss are directional in non-boss views', () => {
    expect(bubbleMeta(msg(1, 'human', 'boss'), true).meta).toBe(`${time} · boss ← human`);
  });

  it('labels boss traffic to a project as directional', () => {
    expect(bubbleMeta(msg(1, 'boss', 'taskflow, lobby'), false).meta).toBe(
      `boss → taskflow, lobby · ${time}`,
    );
  });
});
