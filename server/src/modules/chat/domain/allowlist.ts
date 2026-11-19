// Chat domain - peer allowlist policy predicate (modules/chat/domain).
//
// Pure: the loader lives in infrastructure; the decision lives here so the
// application layer never depends on how the file is read. The policy speaks
// in ROLES (human, boss, coordinator, developer, ...), never agent names.
export type PeerAllowlist = Readonly<Record<string, readonly string[]>>;

/** A sender role may address a recipient role only when its key exists and
 *  lists it. No wildcard: the role roster in the registry already answers
 *  "everyone of this kind". `Object.hasOwn` keeps prototype members
 *  (`constructor`, `__proto__`, ...) from being treated as policy rows. */
export function isPairAllowed(allowlist: PeerAllowlist, senderRole: string, recipientRole: string): boolean {
  if (!Object.hasOwn(allowlist, senderRole)) return false;
  const allowed = allowlist[senderRole];
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(recipientRole);
}
