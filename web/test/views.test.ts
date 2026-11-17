// View semantics ported from src/data/api.ts (legacy behavior source).
import { describe, expect, it } from 'vitest';
import {
  Agent,
  Message,
  defaultTargets,
  involves,
  isVisible,
  projectGroups,
  viewParam,
} from '../src/lib/api';

const AGENTS: Agent[] = [
  { name: 'taskflow', project: 'TaskFlow' },
  { name: 'immigapp', project: 'ImmigApp' },
  { name: 'lobby', project: 'TaskFlow' },
];

const msg = (id: number, from: string, to: string | null, text = ''): Message => ({
  id,
  time: '2026-11-17T10:00:00.000Z',
  from,
  to,
  text,
});

describe('viewParam', () => {
  it('maps views to the server view forms', () => {
    expect(viewParam(null)).toBeNull();
    expect(viewParam({ kind: 'all' })).toBe('all');
    expect(viewParam({ kind: 'boss' })).toBe('boss');
    expect(viewParam({ kind: 'agent', name: 'taskflow' })).toBe('agent:taskflow');
    expect(viewParam({ kind: 'project', name: 'TaskFlow' })).toBe('project:TaskFlow');
  });
});

describe('involves', () => {
  it('matches sender, broadcast, and comma-separated direct recipients', () => {
    expect(involves(msg(1, 'taskflow', null), 'taskflow')).toBe(true);
    expect(involves(msg(1, 'boss', 'all'), 'immigapp')).toBe(true);
    expect(involves(msg(1, 'boss', 'taskflow, lobby'), 'lobby')).toBe(true);
    expect(involves(msg(1, 'boss', 'taskflow, lobby'), 'immigapp')).toBe(false);
  });
});

describe('isVisible', () => {
  it('all view shows everything', () => {
    expect(isVisible(msg(1, 'immigapp', null), { kind: 'all' }, AGENTS)).toBe(true);
  });

  it('boss view: boss replies + traffic addressed to boss (direct agent sends bypass)', () => {
    expect(isVisible(msg(1, 'boss', null), { kind: 'boss' }, AGENTS)).toBe(true);
    expect(isVisible(msg(2, 'taskflow', 'boss'), { kind: 'boss' }, AGENTS)).toBe(true);
    expect(isVisible(msg(3, 'human', 'taskflow'), { kind: 'boss' }, AGENTS)).toBe(false);
  });

  it('agent view: traffic involving that agent', () => {
    expect(isVisible(msg(1, 'taskflow', 'boss'), { kind: 'agent', name: 'taskflow' }, AGENTS)).toBe(true);
    expect(isVisible(msg(2, 'boss', 'all'), { kind: 'agent', name: 'taskflow' }, AGENTS)).toBe(true);
    expect(isVisible(msg(3, 'boss', 'immigapp'), { kind: 'agent', name: 'taskflow' }, AGENTS)).toBe(false);
  });

  it('project view: any of the project agents involved', () => {
    expect(isVisible(msg(1, 'boss', 'lobby'), { kind: 'project', name: 'TaskFlow' }, AGENTS)).toBe(true);
    expect(isVisible(msg(2, 'boss', 'immigapp'), { kind: 'project', name: 'TaskFlow' }, AGENTS)).toBe(false);
  });
});

describe('defaultTargets', () => {
  it('preselects per view kind (composer picker defaults)', () => {
    expect(defaultTargets({ kind: 'agent', name: 'taskflow' }, AGENTS)).toEqual(['taskflow']);
    expect(defaultTargets({ kind: 'project', name: 'TaskFlow' }, AGENTS)).toEqual(['taskflow', 'lobby']);
    expect(defaultTargets({ kind: 'all' }, AGENTS)).toEqual(['taskflow', 'immigapp', 'lobby']);
    expect(defaultTargets({ kind: 'boss' }, AGENTS)).toEqual([]);
  });
});

describe('projectGroups', () => {
  it('groups agents by project preserving order', () => {
    expect(projectGroups(AGENTS)).toEqual({
      TaskFlow: [AGENTS[0], AGENTS[2]],
      ImmigApp: [AGENTS[1]],
    });
  });
});
