# Peer messaging - role-based policy (design revision)

**Status: CURRENT (approved 2026-11-19, implemented).** This is the doc to read
for the peer-messaging policy and wake rules. It supersedes the policy and wake
sections of `2026-11-19-peer-to-peer-agent-messaging-design.md`; everything else
in that document (identity derivation, persistence, suppression, delivery state,
trust limits) still applies.

Audience: Agents-Lobby maintainers and implementers.

## Why this revision

The first design treated the allowlist as a per-identity ACL: keys were agent
names, and a send was allowed only if `(senderName, recipientName)` appeared in
the file. The human's actual model is a **role topology**:

```json
{
  "human": ["boss", "coordinator", "developer"],
  "boss": ["human", "coordinator"],
  "coordinator": ["human", "boss"],
  "developer": ["human", "coordinator"]
}
```

- `human` = the human.
- `boss` = the boss agent.
- `coordinator` = every agent acting as a coordinator (on this machine:
  `greg`, `ruben`, `Dummy`).
- `developer` = every agent acting as a developer.

The file says **who may talk to which kind of participant**, not which named
agent may reach which named agent. Consequences the first design gets wrong:
`boss -> coordinator` must fan out to every coordinator, and `ruben` must be
recognised as a coordinator without the file naming it.

## Goals

- Policy is expressed in roles; adding an agent to an existing role needs no
  policy edit.
- A role addressed as a recipient reaches every agent holding it.
- A named recipient is still allowed, when its role is permitted.
- An agent without a role cannot send or receive peer traffic (fail closed).
- No change to the dashboard, to message persistence shape, or to the wake
  boundary.

## Non-goals

- No per-agent hierarchy inside a role (all coordinators are equal).
- No role administration UI; roles live in the machine's registry.
- No change to `Human:` / `Boss:` / `Peer <name>:` prefixes.
- No change to credentials, delivery semantics, or the trust model.

## Data model

An agent's role is a registry property, not a file property:

```json
{
  "boss": { "name": "boss", "project": "Agents-Lobby", "session": "ses_..." },
  "agents": [
    { "name": "ruben", "project": "TaskFlow", "session": "ses_...", "role": "coordinator" },
    { "name": "greg",  "project": "TaskFlow", "session": "ses_...", "role": "coordinator" },
    { "name": "Dummy", "project": "TaskFlow", "session": "ses_...", "role": "coordinator" }
  ]
}
```

- `role` is an optional string on an agent entry (`z.string().min(1).optional()`).
- The role lives in `agents.json` (machine-local, gitignored), so leaf projects
  need no configuration change and no session restart.
- The existing `agents` mirror table and `/api/agents` are untouched: the
  policy reads the registry snapshot the send path already loads. No migration.

## Policy semantics

`isPairAllowed(allowlist, senderRole, recipientRole)` returns true only when the
sender's key exists and lists the recipient's role. Absent key or absent role =
deny.

Role of a principal:

| Principal | Role |
|---|---|
| `human` | `human` |
| `boss` | `boss` |
| agent entry with `role` | that role |
| agent entry without `role`, unknown name | none -> every peer send and every peer receipt is refused |

Recipient resolution for a send:

- **Role name** (`coordinator`): every registry agent whose `role` equals it;
  the send fans out one prompt per target. Zero holders = `404 no_targets`.
- **Agent name** (`ruben`): that agent, allowed only if its role is listed for
  the sender's role. An unnamed agent has no role, so it cannot be addressed.
- **`human` / `boss`**: the singleton principal (`human` remains archive-only,
  no session).
- **`all`**: authority senders only (`human`, `boss`), expanding to every agent
  whose role the sender's list permits; kept for compatibility with the existing
  broadcast.

`"*"` wildcard support is removed: roles express the same intent without a
second mechanism, and two mechanisms invite drift.

## Persistence and delivery with fan-out

- One row per send (unchanged): `to` is the joined successful targets, `from`
  the sender, `body` the exact request body, `messageId` the idempotency key.
- One prompt per target, composed with the sender's existing prefix
  (`Peer <name>:`, `Boss:`, `Human:`).
- The sender-turn arm is per send, not per target: a peer fan-out still
  suppresses exactly one delivery-turn transcript.
- `delivery_state`: `1` when every target accepted the prompt, `0` when any
  failed. Reconciliation re-prompts the row's targets once, so a partial
  fan-out may duplicate to targets that already received it - the same "one
  duplicate, never a loss" rule already accepted for the single-target case.

## Compatibility

- Existing named entries in the allowlist stop being authoritative: the file is
  rewritten to the four roles in the same change.
- Roles are registry data. **An agent without a `role` is inert for everything**:
  it cannot send, cannot be addressed by name, and is skipped by `all` - for
  Human/Boss senders too. That is deliberate: seeding a role is what opts an
  agent into peer messaging. (Earlier wording claimed Human/Boss sends keep
  working without roles; the code and the human's intent agree on denial.)
- Credentials are unchanged: tokens bind a principal to a name; roles are
  derived from the registry, never from the request.
- Registry validation is loud: a role must be lowercase `[a-z0-9_-]+`, may not
  be `human`/`boss`/`all`, and a name may not contain whitespace, a comma or a
  colon (names become identities and prefix text). Duplicate names stay
  listable (bridge compatibility) but cannot send - identity would be
  ambiguous (`409 ambiguous_sender`).

## Verification focus

- `boss -> coordinator` prompts every coordinator once; an empty role roster is
  `404`.
- `ruben -> boss` allowed because `ruben` is a coordinator.
- `ruben -> greg` denied (coordinator may not address coordinator).
- `human -> developer` allowed; `developer -> human` allowed; `developer ->
  boss` denied.
- An agent with no `role` is refused as sender and as recipient.
- Named recipient allowed/denied according to its role.
- `to: "all"` from an agent is refused; from `human` it expands to permitted
  roles only.
- Trailing-comma/invalid policy file fails loudly; absent file denies peers.
- Fan-out row: one row, joined `to`, per-target prompts, `delivery_state`
  semantics, reconciliation once.

## Accepted residuals (unchanged from the first design)

- O02: manual desktop typing is invisible to the lobby.
- A multi-segment turn suppresses only its first captured segment.
- A prompt arriving while the send's own turn runs can let that transcript
  archive as a duplicate row.
- Credentials bind identity and give an audit trail; they are not isolation
  between agents sharing one OS user.
- The policy governs lobby traffic only; a session can still prompt another
  directly through the OpenCode API.
