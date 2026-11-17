// Composer target resolution (legacy Composer.tsx submit rule): the Boss
// view composes through /prompt (webchat → boss); every other view
// direct-sends a `Human:` message via /send to the picked agents — an empty
// picker in the All view broadcasts to 'all'.
import { describe, expect, it } from 'vitest';
import { composeTarget } from '../src/lib/api';

describe('composeTarget', () => {
  it('boss view always prompts (picker is disabled there)', () => {
    expect(composeTarget({ kind: 'boss' }, new Set(['a']))).toEqual({ kind: 'prompt' });
    expect(composeTarget({ kind: 'boss' }, new Set())).toEqual({ kind: 'prompt' });
  });

  it('agent view sends directly to that agent', () => {
    expect(composeTarget({ kind: 'agent', name: 'taskflow' }, new Set(['taskflow']))).toEqual({
      kind: 'send',
      to: ['taskflow'],
    });
  });

  it('project view sends to the picked agents', () => {
    expect(
      composeTarget({ kind: 'project', name: 'TaskFlow' }, new Set(['taskflow', 'lobby'])),
    ).toEqual({ kind: 'send', to: ['taskflow', 'lobby'] });
  });

  it('all view with nothing picked broadcasts to all agents', () => {
    expect(composeTarget({ kind: 'all' }, new Set())).toEqual({ kind: 'send', to: 'all' });
  });

  it('all view with a partial picker sends to the picked set only', () => {
    expect(composeTarget({ kind: 'all' }, new Set(['immigapp']))).toEqual({
      kind: 'send',
      to: ['immigapp'],
    });
  });
});
