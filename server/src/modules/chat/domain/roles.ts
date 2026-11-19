// Chat domain - who a principal IS, in policy terms (modules/chat/domain).
//
// The policy speaks in roles, not agent names: `human`, `boss`, and whatever
// role an agent carries in the registry (coordinator, developer, ...). A role
// is never taken from a request or a token - only from the registry - so a
// credential cannot promote itself.
import type { RegistryEntry } from '../application/ports.js';

export type Role = string;

export interface RoleRegistry {
  readonly boss: RegistryEntry | null;
  readonly agents: readonly RegistryEntry[];
}

/** The principal's role, or null when it has none (unknown name, or an agent
 *  entry without a `role`). Null always means "deny" at the policy boundary. */
export function roleOfPrincipal(name: string, registry: RoleRegistry): Role | null {
  if (name === 'human') return 'human';
  if (name === 'boss') return 'boss';
  const entry = registry.agents.find((a) => a.name === name);
  return entry?.role ?? null;
}

/** Every registered agent holding `role`, in registry order. */
export function agentsWithRole(registry: RoleRegistry, role: Role): RegistryEntry[] {
  return registry.agents.filter((a) => a.role === role);
}

/** An agent entry is addressable only when its role exists and the sender's
 *  policy lists that role. */
export function recipientRoleOf(name: string, registry: RoleRegistry): Role | null {
  return roleOfPrincipal(name, registry);
}
