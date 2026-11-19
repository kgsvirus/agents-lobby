// Role resolution and role-pair policy.
//
// The policy file speaks in roles; the registry says which role an agent has.
// A principal with no role is denied (fail closed) both as sender and as a
// recipient - that is what keeps marvin/porty inert until they are seeded.
import { describe, expect, it } from 'vitest';
import { isPairAllowed } from '../src/modules/chat/domain/allowlist.js';
import { agentsWithRole, roleOfPrincipal, type RoleRegistry } from '../src/modules/chat/domain/roles.js';

const registry: RoleRegistry = {
  boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
  agents: [
    { name: 'ruben', project: 'TaskFlow', session: 'ses_r', role: 'coordinator' },
    { name: 'greg', project: 'TaskFlow', session: 'ses_g', role: 'coordinator' },
    { name: 'Dummy', project: 'TaskFlow', session: 'ses_d', role: 'coordinator' },
    { name: 'marvin', project: 'ImmigApp', session: 'ses_m' },
  ],
};

const ACL = {
  human: ['boss', 'coordinator', 'developer'],
  boss: ['human', 'coordinator'],
  coordinator: ['human', 'boss'],
  developer: ['human', 'coordinator'],
};

describe('roleOfPrincipal', () => {
  it('maps the fixed principals and the registry roles', () => {
    expect(roleOfPrincipal('human', registry)).toBe('human');
    expect(roleOfPrincipal('boss', registry)).toBe('boss');
    expect(roleOfPrincipal('ruben', registry)).toBe('coordinator');
  });

  it('returns null for an agent without a role and for an unknown name', () => {
    expect(roleOfPrincipal('marvin', registry)).toBeNull();
    expect(roleOfPrincipal('ghost', registry)).toBeNull();
  });

  it('lists every agent holding a role, in registry order', () => {
    expect(agentsWithRole(registry, 'coordinator').map((a) => a.name)).toEqual(['ruben', 'greg', 'Dummy']);
    expect(agentsWithRole(registry, 'developer')).toEqual([]);
  });
});

describe('isPairAllowed - roles only', () => {
  it('allows exactly the listed role pairs', () => {
    expect(isPairAllowed(ACL, 'coordinator', 'boss')).toBe(true);
    expect(isPairAllowed(ACL, 'coordinator', 'human')).toBe(true);
    expect(isPairAllowed(ACL, 'human', 'coordinator')).toBe(true);
    expect(isPairAllowed(ACL, 'boss', 'human')).toBe(true);
  });

  it('denies unlisted pairs, including a role addressing itself', () => {
    expect(isPairAllowed(ACL, 'coordinator', 'coordinator')).toBe(false);
    expect(isPairAllowed(ACL, 'coordinator', 'developer')).toBe(false);
    expect(isPairAllowed(ACL, 'developer', 'boss')).toBe(false);
  });

  it('has no wildcard escape hatch', () => {
    const withStar = { human: ['*'], boss: ['*'] } as unknown as Record<string, string[]>;
    expect(isPairAllowed(withStar, 'human', 'developer')).toBe(false);
    expect(isPairAllowed(withStar, 'boss', 'coordinator')).toBe(false);
  });

  it('denies an absent sender role', () => {
    expect(isPairAllowed(ACL, 'reviewer', 'boss')).toBe(false);
  });
});
