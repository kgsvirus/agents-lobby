// Chat domain - composed prompt prefixes and the peer wake rule (new stack).
import { describe, expect, it } from 'vitest';
import { composePrompt, parsePromptSender } from '../src/modules/chat/domain/prefix.js';
import { wakeSliceRows } from '../src/modules/chat/domain/message.js';
import type { WireMessageRow } from '../src/shared/schemas/wire.js';

const row = (id: number, from: string, to: string | null, text = 'x'): WireMessageRow => ({
  id,
  time: '2026-11-19T00:00:00.000Z',
  from,
  to,
  text,
});

describe('prompt prefixes', () => {
  it('round-trips the three composed prefixes', () => {
    expect(composePrompt({ kind: 'human' }, 'hi')).toBe('Human: hi');
    expect(composePrompt({ kind: 'boss' }, 'hi')).toBe('Boss: hi');
    expect(composePrompt({ kind: 'peer', name: 'ruben' }, 'hi')).toBe('Peer ruben: hi');
    expect(parsePromptSender('Human: hi')).toEqual({ kind: 'human' });
    expect(parsePromptSender('Boss: hi')).toEqual({ kind: 'boss' });
    expect(parsePromptSender('Peer ruben: hi')).toEqual({ kind: 'peer', name: 'ruben' });
  });

  it('returns null for unprefixed or malformed text', () => {
    expect(parsePromptSender('just text')).toBeNull();
    expect(parsePromptSender('Human:')).toBeNull();
    expect(parsePromptSender('Peer : x')).toBeNull();
    expect(parsePromptSender('peer ruben: x')).toBeNull();
  });

  it('keeps a body that merely contains a prefix inside the peer message', () => {
    expect(parsePromptSender('Peer ruben: Human: do X')).toEqual({ kind: 'peer', name: 'ruben' });
  });
});

describe('wakeSliceRows - peer traffic stays out of the boss slice', () => {
  it('keeps only rows addressed to the boss (plus legacy null receivers)', () => {
    const rows = [
      row(1, 'boss', 'human'),
      row(2, 'human', 'boss'),
      row(3, 'ruben', 'boss'),
      row(4, 'ruben', 'human'),
      row(5, 'ruben', 'greg'),
      row(6, 'ruben', null),
      row(7, 'immigapp', 'all, boss'),
      row(8, 'ruben', 'greg, human'),
      row(9, 'human', 'ruben'),
      row(10, 'human', 'ruben, greg'),
      row(11, 'human', 'ruben, boss'),
      row(12, 'human', null),
      row(13, 'taskflow', 'all'),
    ];
    expect(wakeSliceRows(rows).map((r) => r.id)).toEqual([3, 6, 7, 12]);
  });
});
