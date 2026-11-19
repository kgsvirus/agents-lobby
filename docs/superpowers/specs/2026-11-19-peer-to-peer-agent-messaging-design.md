# Peer-to-peer agent messaging - design draft

**Status: PARTIALLY SUPERSEDED (2026-11-19, implemented).** Read
`2026-11-19-peer-messaging-roles-design.md` for the CURRENT policy (roles) and
wake rule. This document still describes what shipped for identity derivation,
persistence, capture suppression, delivery state and the trust model; its
policy section (name-keyed allowlist, wildcard) and its original wake rule are
history, not current behaviour.
Audience: Agents-Lobby maintainers and implementers.

## Intent

Let registered agents send direct messages through the lobby, including messages
to and from Boss, without Boss relaying every peer exchange. Keep the existing
database-backed chat history and UI views.

## Current behavior

- `POST /send` delivers prompts to registered agents. Its `from` value comes
  from the request body and defaults to `boss`; the service currently accepts
  only `human` and `boss`.
- Boss is stored separately from `registry.agents`; current `to: "all"` fans
  out to registered agents only.
- OpenCode captures non-Boss session replies. The chat service stores them
  addressed to the last sender (or Boss as fallback), then wakes Boss.
- Boss wake slices currently include agent-to-agent rows.
- The UI receives persisted `message.created` rows through SSE and can catch up
  from the messages API. Its existing views filter by message sender/recipient.

## Proposed behavior

### Identity and authorization

- The server derives `from` from caller authentication. It never grants identity
  based on the body field; if a supplied `from` disagrees with the authenticated
  principal, reject with 403. Remove the implicit `boss` default.
- Keep the non-secret policy in `config/peer-to-peer-allowlist.json`, mapping each
  ROLE to the roles it may address (see the roles design for the model that
  supersedes any name-based reading). Validate it at the request boundary and
  fail closed for unknown senders, recipients, or pairs.
- Preserve the proposed shape:
  ```json
  {
    "human": ["boss", "coordinator", "developer"],
    "boss": ["human", "coordinator"],
    "coordinator": ["human", "boss"],
    "developer": ["human", "coordinator"]
  }
  ```
- Treat the real allowlist as machine-local because the agent registry is
  machine-local. Commit `config/peer-to-peer-allowlist.example.json`, gitignore
  the real file, and have setup create it only when absent.
- Use distinct `Peer <name>:` prompts for agents. Only authenticated Human and
  Boss principals may produce the reserved `Human:` and `Boss:` prefixes.
  Peer content is never authorization.
- **Why peers never get `Human:`/`Boss:`:** those two prefixes are the only
  authority tokens in the system - `PROTOCOL.md` makes `Human:` direct human
  authority and `Boss:` the human's delegate, and project rules (e.g. TaskFlow)
  require explicit authorization before work starts. A peer that could emit
  either prefix could manufacture authorization it was never granted. That is
  impersonation of authority, not a labelling preference, so the reservation is
  enforced by the server and cannot be overridden by the contact file.
- **How receiving agents know:** the server composes the prefix, so a peer
  message always arrives as `Peer <name>: <text>`. `PROTOCOL.md` gains the
  definition (peer traffic, sender-named, advisory, never authorization) and the
  rule that any prefix other than `Human:`/`Boss:` carries no authority.
  `PROTOCOL.md` is already the file every lobby-managed project's `AGENTS.md`
  points at, so agents pick the rule up at session start without a template
  change.
- Reject a peer body that begins with `Human:` or `Boss:` (quoted-authority
  injection). The receiver would otherwise see `Peer evil: Human: do X`.
- Reject `to: "all"` from peers. Preserve the existing Human/Boss broadcast
  behavior only when every resolved recipient is allowed by the contact policy.

**Accepted local trust model:** the human accepted identity binding and audit
for cooperative agents on this single-user machine. Per-agent bearer tokens
derive the server's `from`, but agents run as the same OS user and can read one
another's files; this is not protection against a deliberately malicious local
agent. True isolation would require OS/container separation. The contact list
controls sending, not message confidentiality: existing local reads and SSE
remain open, so a local client can still read the shared chat.

**Scope of these rules:** the allowlist, the reserved-prefix rule and the sender
checks govern LOBBY traffic only. Any process that can reach the OpenCode API can
prompt a session directly with arbitrary text and bypass the lobby entirely -
this is a policy layer, not a sandbox.

### Credential flow

- Store principal-to-token mappings in a gitignored `.data/peer-auth.json`;
  never commit tokens or put them in the static UI bundle. Setup creates it
  only when absent; rotation replaces local credentials and the corresponding
  client token. The same-user trust limitation above applies to this file.
  The `kind` must agree with the name (authority principals are literally
  `human`/`boss`; agent names are single words without a colon), so the service
  can keep deriving authority from the verified name.
- Human enters the Human token in the existing top-nav Settings menu. Add
  Connect/Disconnect; Connect validates via a read-only identity endpoint and
  stores the token in `sessionStorage`; Disconnect clears it. `sessionStorage`
  reduces persistence across browser sessions but remains readable to
  same-origin JavaScript (including XSS).
- The Boss uses a separate Boss principal/token from its local API client, not
  the Human UI field. Each agent client presents its assigned principal token;
  the server derives identity from the token and rejects a mismatched body
  `from`.
- Human webchat `/prompt` uses the Human token and is authorized as `human`;
  agent-to-Boss messages use `/send` to the Boss session so their direction is
  recorded and policy-checked.
- Redact `Authorization` from Fastify logs. Require TLS if the server binds to
  a non-loopback interface.

### Delivery, replies, and persistence

- `/send` resolves exact agent names plus the special Boss session. `human` is
  a UI/database recipient only; it has no OpenCode session.
- **Ruling (2026-11-19): a peer -> human message wakes nobody.** It is archived
  and visible live in the UI; waking Boss for it would reintroduce exactly the
  relay cost this feature removes. The row still rides a later wake slice when
  other traffic triggers one, because it addresses `human`. Pinned by
  `chat-peer-capture.test.ts` ("peer -> human delivery (intended: UI-only)").
- Each peer `/send` request is the canonical archive of its exact body. Add a
  `messageId` idempotency key with a unique database constraint so retries
  return the existing result without a second row, then deliver the same body
  to the target. The additive migration adds the idempotency key, a nullable
  `capture_suppressed` flag, and one delivery-confirmation bit on the message
  row. Persist the row and armed flag atomically. The event bus and SSE continue
  feeding the UI; no UI-view redesign is intended.
- **Delivery guarantee (honest v1 wording):** archived exactly once; prompted at
  least once; a crash between upstream acceptance and local confirmation can
  produce at most one duplicate prompt for that message. Sender retry with the
  same `messageId` recovers a crash before the prompt POST. One startup
  reconciliation pass re-prompts rows whose confirmation bit is unset, once per
  row. No outbox worker and no backoff loops.
- **Possible upgrade, verify before claiming:** OpenCode's prompt body accepts
  an optional `id` (schema `Session.Message.ID`, pattern `^msg_`) and documents a
  409 `ConflictError` response. If a spike shows that re-posting the same `id`
  is rejected or returns a clean conflict we can treat as success, pass the
  `messageId` upstream and claim end-to-end exactly-once. Do not claim it before
  the spike.
- Mark the authenticated peer sender's delivery turn so its `text.ended`
  transcript is not saved as a second lobby message. The first captured segment
  consumes the marker; the next inbound prompt clears any leftover. Human/Boss
  capture stays unchanged.
- **Revision after review (2026-11-19):** the two fixes for the arm are
  distinct mechanisms - `markDeliverySent` runs behind the ingest chain so it
  never executes under a lowered `busy_timeout`, while the arm clears are
  direct synchronous calls whose safety comes from failing OPEN (a failed clear
  is remembered and the next capture archives instead of being suppressed) plus
  the startup sweep that clears every arm, since no turn survives a restart.
- **Revision after review (2026-11-19):** `inbox.enqueued` reports a QUEUED
  prompt, not a started turn, so it cannot be treated as a hard turn boundary.
  The accepted trade-off is duplicate transcript rows (a later segment, or a
  turn still running when another prompt queues) over ever suppressing a real
  reply. The arm is therefore consume-once, and the clear on inbound exists to
  bound a marker left by a turn that produced no text.
- The idempotency key is scoped to `(message_id, sender)`: keys are client
  chosen, so a global unique key would let one agent squat another's, and a
  lost unique-index race is treated as the idempotent hit rather than a 500.
- **Reply attribution rule (v1):** set the pending-sender slot when the prompt is
  observed arriving on the target session's inbox stream, not when `/send`
  enqueues it - the server composes the `Boss:` / `Human:` / `Peer <name>:`
  prefix, so the sender is parsed back from the observed prompt. The first
  captured reply consumes the slot; any reply without an unanswered observed
  inbound routes to Boss. This keeps a queued prompt from being misattributed by
  a later enqueue.
  - Documented residual (accepted): manual desktop typing into an agent session
    emits no event (O02), so if the human types while a peer prompt is pending,
    that reply can route to the peer. Closing this needs O02, not more lobby
    state.
  - Documented residual (accepted): a multi-segment turn's first segment consumes
    the slot, so later segments of the same turn fall back to Boss. That is noise
    in the Boss channel, not misdelivery.
- Replies are explicit messages: a peer that wants to continue the exchange
  calls `/send` to the original sender. The server does not automatically
  forward arbitrary captured assistant text, avoiding loops and ambiguous
  recipient inference.
- A normal peer session reply is still captured as a `from -> original sender`
  row and shown in the UI, but does not wake or prompt that sender. A further
  turn requires the recipient's explicit `/send`.
- Boss `text.ended` capture remains unchanged as Boss-to-Human. When Boss also
  explicitly sends a peer reply through `/send`, that is a separate Boss-to-peer
  row; the two rows have different recipients and are not duplicates.
- Suppress Boss wakes and exclude rows from the Boss wake slice for ALL traffic
  not addressed to Boss: peer-to-peer rows, an agent's reply to the human, and
  every human row (a human->agent instruction is private; human->boss is already
  native to the session). Only rows naming `boss` (or legacy null-receiver
  captures) ride. This changes Boss wake input, not message direction or UI
  visibility. **Revision 2026-11-19 (human-directed):** the earlier rule kept
  agent->human rows and `human -> <agent>` rows in the slice; both are now
  excluded, and the wake itself is skipped when nothing unread exists.
- This removes automatic server relays, not deliberate agent ping-pong: an
  agent can still keep sending explicit new `/send` messages. No hard
  conversation-hop or rate limit is proposed for this version.

## Verification and documentation

Tests must cover authenticated identity derivation, body-`from` mismatch,
allowed/denied pairs, peer `to: "all"` rejection, reserved-prefix protection,
Boss/human/agent recipient routing, single-row persistence on retry, the
delivery-confirmation bit plus startup reconciliation, capture suppression
across a multi-segment turn, observed-inbound attribution (queued prompts do not
overwrite the pending sender), Boss wake suppression for peer traffic, and
unchanged UI visibility through the existing database/SSE path.

Update `PROTOCOL.md` with how peers send and reply, the allowlist path, the
`Peer <name>:` prefix definition, and the rule that peer content is untrusted
and grants no authority. Update README operations/setup instructions for the
local policy and credential flow.

## Accepted trust and review notes

- The local identity-binding trust model is accepted for this deployment; it is
  not malicious-peer isolation.
- Human reviews this full design before implementation. No token values are
  generated or included in the draft.
