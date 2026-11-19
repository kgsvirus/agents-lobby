# Peer messaging roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Express the peer-messaging policy as roles (human, boss, coordinator, developer) resolved from the registry, with role-addressed sends fanning out to every agent holding that role.

**Architecture:** The registry snapshot already loaded by every send carries each agent's optional `role`, so policy needs no new storage and no migration. A pure domain helper resolves a principal to a role and answers `isPairAllowed(roleSender, roleRecipient)`; the service resolves `to` into a target set (role -> all holders, name -> one agent, `all` -> authority only) before the existing prompt/archive path runs unchanged.

**Tech Stack:** Node 24, TypeScript, Fastify 5, better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-peer-messaging-roles-design.md` (supersedes the identity/policy sections of `2026-11-19-peer-to-peer-agent-messaging-design.md`).

## Global Constraints

- `role` is optional in `agents.json`; an agent without a role is denied as sender and as recipient (fail closed).
- No database migration, no dashboard change, no change to `Human:` / `Boss:` / `Peer <name>:` prefixes.
- `"*"` wildcard support is removed from `isPairAllowed`.
- `to: "all"` remains authority-only (`human`, `boss`) and expands to agents whose roles the sender may address.
- The real `config/peer-to-peer-allowlist.json` is machine-local and gitignored; the example is committed.
- A malformed policy file (including a trailing comma) fails loudly with `allowlist_invalid`; it never silently opens or closes every pair.
- ASCII punctuation in repo files.
- Verify with `npm test` (root) and `npm run build -w server`.
- **Commit gate:** every task ends with a commit step, but a commit happens only once the human says "commit". Until then, make the change, run its tests, report, and leave the tree dirty.

## Review Focus

- `boss -> coordinator` with three coordinators registered -> three prompts, one row.
- `boss -> coordinator` with no coordinator registered -> `404 no_targets`, nothing archived.
- `ruben -> greg` (coordinator -> coordinator) -> `403 forbidden_pair`.
- An agent present in the registry but without `role` -> denied as sender and as recipient, no crash.
- `to: "all"` from an agent -> `403`; from `human` -> only roles listed for `human`.
- Policy file with a trailing comma -> loud `allowlist_invalid` (500), never a silent open.

---

### Task 1: Registry role field

**Files:**
- Modify: `server/src/infrastructure/registry/reader.ts:20-28`
- Modify: `server/src/modules/chat/application/ports.ts:55-60` (`RegistryEntry`)
- Test: `server/test/config.test.ts` or a new `server/test/registry-role.test.ts`

**Interfaces:**
- Produces: `RegistryEntry` gains `readonly role?: string`; `agents.json` accepts `role` per agent entry.

- [ ] **Step 1: Write the failing test**

```ts
it('reads an optional role per agent and keeps entries without one', () => {
  const snapshot = parseRegistry({ agents: [
    { name: 'ruben', project: 'TaskFlow', session: 'ses_r', role: 'coordinator' },
    { name: 'marvin', project: 'ImmigApp', session: 'ses_m' },
  ] });
  expect(snapshot.agents.map((a) => a.role)).toEqual(['coordinator', undefined]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run server/test/registry-role.test.ts`
Expected: FAIL - role is stripped by the schema.

- [ ] **Step 3: Add the field**

In `registryFileSchema.agents` entries and the boss entry: `role: z.string().min(1).optional()`. Mirror the field on `RegistryEntry`. Do NOT add it to the `agents` mirror table or `/api/agents` output.

- [ ] **Step 4: Run the test again**

Run: `npx vitest run server/test/registry-role.test.ts server/test/agent-routes.test.ts` (or the agents tests present)
Expected: PASS, existing agent output unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/src/infrastructure/registry/reader.ts server/src/modules/chat/application/ports.ts server/test
git commit -m "feat (v1): optional agent role in the registry"
```

---

### Task 2: Role resolution and role-pair policy (pure domain)

**Files:**
- Modify: `server/src/modules/chat/domain/allowlist.ts`
- Create: `server/src/modules/chat/domain/roles.ts`
- Test: `server/test/peer-allowlist.test.ts`, `server/test/chat-domain.test.ts`

**Interfaces:**
- Produces:
  - `type Role = string`
  - `roleOfPrincipal(name: string, registry: { boss: RegistryEntry | null; agents: readonly RegistryEntry[] }): Role | null` - `human` -> `'human'`, `boss` -> `'boss'`, agent entry -> its `role` or null.
  - `isPairAllowed(allowlist: PeerAllowlist, senderRole: Role, recipientRole: Role): boolean` - no wildcard.

- [ ] **Step 1: Write the failing tests**

```ts
it('maps principals to roles and refuses unknown or role-less agents', () => {
  const registry = { boss: { name: 'boss', project: 'x', session: 's' }, agents: [
    { name: 'ruben', project: 'TaskFlow', session: 'ses_r', role: 'coordinator' },
    { name: 'marvin', project: 'ImmigApp', session: 'ses_m' },
  ] };
  expect(roleOfPrincipal('human', registry)).toBe('human');
  expect(roleOfPrincipal('boss', registry)).toBe('boss');
  expect(roleOfPrincipal('ruben', registry)).toBe('coordinator');
  expect(roleOfPrincipal('marvin', registry)).toBeNull();
  expect(roleOfPrincipal('ghost', registry)).toBeNull();
});

it('allows only listed role pairs, with no wildcard', () => {
  const acl = { human: ['boss', 'coordinator'], boss: ['human'], coordinator: ['human', 'boss'] };
  expect(isPairAllowed(acl, 'coordinator', 'boss')).toBe(true);
  expect(isPairAllowed(acl, 'coordinator', 'coordinator')).toBe(false);
  expect(isPairAllowed(acl, 'coordinator', 'developer')).toBe(false);
  expect(isPairAllowed({ human: ['*'] } as never, 'human', 'developer')).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run server/test/peer-allowlist.test.ts server/test/chat-domain.test.ts`
Expected: FAIL - `roles.ts` missing; wildcard test fails on the current implementation.

- [ ] **Step 3: Implement**

`roles.ts`: `roleOfPrincipal` reads the registry snapshot, returns the fixed role for `human`/`boss`, the agent's `role` otherwise, null when unknown. `allowlist.ts`: drop `'*'` handling, compare roles only, keep fail-closed defaults.

- [ ] **Step 4: Run the tests again**

Run: `npx vitest run server/test/peer-allowlist.test.ts server/test/chat-domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/chat/domain/allowlist.ts server/src/modules/chat/domain/roles.ts server/test
git commit -m "feat (v1): role resolution and role-pair policy"
```

---

### Task 3: Recipient resolution with role fan-out

**Files:**
- Modify: `server/src/modules/chat/application/chat-service.ts` (`#sendPeer`, `#sendFromAuthority`, `#recipientSession`)
- Test: `server/test/chat-send-peer.test.ts`

**Interfaces:**
- Consumes: `roleOfPrincipal`, `isPairAllowed` (Task 2).
- Produces: a private `#resolveTargets(to, senderRole, allowlist, registry, authority): RegistryEntry[]`-shaped helper (agents only); `human`/`boss` resolve to their singletons as today.

- [ ] **Step 1: Write the failing tests**

- `boss -> coordinator` with ruben/greg/Dummy as coordinators: three prompts, one row `to: 'ruben, greg, Dummy'` (registry order).
- `boss -> coordinator` with nobody in that role: `404 no_targets`.
- `ruben -> boss`: allowed (coordinator lists boss).
- `ruben -> greg`: `403 forbidden_pair` (coordinator may not address coordinator).
- `ruben -> coordinator`: `403 forbidden_pair` (role recipients follow the same pair rule; a peer may not address its own role).
- `human -> developer`: expands to every developer.
- `marvin` (no role) as sender: `403`, and as recipient: `403`.
- `to: 'all'` from an agent: `403`; from `human`: only permitted roles.
- `to: 'ruben'` from `boss` when `boss` lists `coordinator`: allowed.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run server/test/chat-send-peer.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

In the service: resolve `senderRole = roleOfPrincipal(senderName, registry)`; deny (`403 forbidden_pair`, message names the missing role) when null. Resolve `to`:
- `'all'` -> authority only, then filter by permitted roles.
- a string equal to `'human'`/`'boss'` -> that singleton.
- a string equal to a role name present in the registry -> all holders of that role, allowed only if the pair is permitted (check once with the role, not per name).
- otherwise an agent name -> that agent, allowed only if its role is permitted.

Keep the existing prompt fan-out, single-row archive, `messageId`, arm and delivery-state logic; replace the per-target name checks with the role check performed during resolution.

- [ ] **Step 4: Run the tests again**

Run: `npx vitest run server/test/chat-send-peer.test.ts server/test/chat-peer-regressions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/chat/application/chat-service.ts server/test/chat-send-peer.test.ts
git commit -m "feat (v1): role-addressed recipients with fan-out"
```

---

### Task 4: Policy files, setup copy, and docs

**Files:**
- Modify: `config/peer-to-peer-allowlist.example.json`
- Modify: `config/peer-to-peer-allowlist.json` (machine-local, gitignored - edit in place)
- Modify: `README.md` (policy table, fan-out, no-role denial), `PROTOCOL.md` (addressing a role), `AGENTS.md` (unchanged unless it names the file)

**Interfaces:** none - configuration and prose.

- [ ] **Step 1: Rewrite both allowlist files**

```json
{
  "human": [
    "boss",
    "coordinator",
    "developer"
  ],
  "boss": [
    "human",
    "coordinator"
  ],
  "coordinator": [
    "human",
    "boss"
  ],
  "developer": [
    "human",
    "coordinator"
  ]
}
```

No trailing comma. The real file keeps the same content (machine-local, so the rosters come from `agents.json`, not from here).

- [ ] **Step 2: Document**

README: replace the allowlist paragraphs with the role table, the "adding an agent to a role needs no policy edit" note, the no-role denial, and fan-out semantics. PROTOCOL: how to address a role (`to: "coordinator"`) and that a peer's role comes from the registry.

- [ ] **Step 3: Verify the files parse**

Run: `npx vitest run server/test/peer-allowlist.test.ts`; add one case there asserting a trailing-comma copy of the example is rejected with `allowlist_invalid` (read the example text, insert a comma before the final `}`, write it to a temp file, expect the loud error). Then start the server once.
Expected: no `allowlist_invalid` at send time, and the trailing-comma case fails loudly.

- [ ] **Step 4: Commit**

```bash
git add config README.md PROTOCOL.md
git commit -m "docs (v1): role-based peer policy"
```

---

### Task 5: Full gate and Ruben re-review

**Files:** none - verification.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all files pass (baseline 40 files / 323 tests plus the new ones). O11 (`chat-dedup` yield test) may flake under load - rerun in isolation if it does, and say so.

- [ ] **Step 2: Build**

Run: `npm run build -w server`
Expected: exit 0.

- [ ] **Step 3: Restart and smoke**

Restart the lobby on :3005, confirm `/api/principal` 401, `/api/messages` 200, `/ui` 200.

- [ ] **Step 4: Ask Ruben to review the delta**

Send him: the spec path, the changed files, the test counts, and the two behaviours most likely to be wrong (role fan-out ordering, no-role denial). No code changes from him.

- [ ] **Step 5: Report, do not commit**

Report the gate results and the diff scope. Commits happen only when the human says "commit" (Global Constraints); nothing in this plan commits on its own.
