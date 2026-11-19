// Chat application — the bridge's message routing, fan-out, prompt-to-boss and
// wake orchestration (bridge.mjs ports). Behavior equivalence with bridge.mjs
// is the acceptance bar; each method cites its bridge source.
//
// Classification policy lives here in domain terms only: the boss-only filter
// compares a normalized item's `to` against the boss identity, and echo
// detection compares the body against the wake text THIS application itself
// enqueues (WAKE_PROMPT — the ruling's own example). No OpenCode wire shapes,
// no Fastify, no drizzle.
import { AppError } from '../../../shared/errors/index.js';
// Through the adapter's ENTRY SURFACE (the documented split points, exported
// consciously from index.ts): the wake text format is adapter-owned
// (byte-identical contract) and NormalizedEvent is the neutral event type.
// Slice CONSTRUCTION below (wakeSliceRows) is this module's own domain logic.
import {
  composeWakePrompt,
  WAKE_PROMPT,
  type NormalizedEvent,
} from '../../../integrations/opencode/index.js';
import type {
  MessagePage,
  MessageQuery,
  NewMessage,
  WireMessageRow,
} from '../domain/message.js';
import { wakeSliceRows } from '../domain/message.js';
import { isPairAllowed } from '../domain/allowlist.js';
import { agentsWithRole, roleOfPrincipal } from '../domain/roles.js';
import { composePrompt, isComposablePeerName, parsePromptSender, type PromptSender } from '../domain/prefix.js';
import type { ChatDeps, PeerAllowlist, RegistryEntry, RegistrySnapshot } from './ports.js';

/** Total ingest busy-retry budget (review round 3, final-review fix 2). The
 *  driver busy_timeout (openDatabase, 5 s) is the FIRST line: BEGIN IMMEDIATE
 *  waits for the write lock. Every attempt's driver wait is CAPPED to
 *  BUSY_ATTEMPT_CAP_MS so one contended capture cannot park the process, and
 *  the retries are separated by an ASYNC nap that yields the event loop. */
const BUSY_RETRY_BUDGET_MS = 15_000;

/** Per-attempt cap on the driver's SYNCHRONOUS busy wait (ms). better-sqlite3
 *  is synchronous: SQLite's busy handler parks the JS thread for the whole
 *  busy_timeout, so an attempt must never wait long. 250 ms bounds the
 *  worst-case stall of unrelated HTTP/SSE handling, and the async nap between
 *  attempts yields the loop (final-review fix 2). Residual bound, honestly
 *  stated: a non-busy statement can still block on an fsync-scale write, and
 *  the driver's busy-wait granularity adds its last sleep past the cap — the
 *  cap plus one such quantum is the irreducible synchronous slice. */
const BUSY_ATTEMPT_CAP_MS = 250;

/** Async backoff nap between busy retries — setTimeout, so the event loop runs
 *  (timers, HTTP, SSE) while another connection holds the write lock. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The SQLITE_BUSY FAMILY (review round 4): better-sqlite3 surfaces SQLite's
 *  EXTENDED result codes as `err.code` — its constants table maps
 *  SQLITE_BUSY_RECOVERY / SQLITE_BUSY_SNAPSHOT / SQLITE_BUSY_TIMEOUT
 *  (constants.cpp 101-102) — so the retry must recognize the primary code
 *  AND the `SQLITE_BUSY_` prefix, while still failing fast on non-busy
 *  errors. */
function isBusyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'SQLITE_BUSY' || (code !== undefined && code.startsWith('SQLITE_BUSY_'));
}

/** The boss's fixed identity. The bridge resolves the boss session to the
 *  literal role name "boss" and never uses the registry entry's own name
 *  (bridge.mjs:162,187 — see createSessionResolver). */
const BOSS = 'boss';

/** bridge.mjs:351 — `from || "unknown"`: truthiness over ANY JSON type; the
 *  raw truthy value reaches the store AS-IS (SQLite TEXT affinity coerces
 *  truthy scalars identically on node:sqlite and better-sqlite3; values the
 *  driver cannot bind reject at the store). The cast only satisfies the
 *  repository's string contract — nothing is written for values the store
 *  rejects (the webhook path maps that to the blanket-catch 400). */
function webhookSender(from: unknown): string {
  return (from || 'unknown') as string;
}

export interface SendInput {
  readonly to: string | readonly string[];
  readonly message: string;
  readonly from?: string;
  /** True when `from` came from a credential (peer path): the allowlist,
   *  prefix reservation and idempotency rules apply. False/absent = the legacy
   *  body-`from` mode (human | boss only). */
  readonly authenticated?: boolean;
  /** Client idempotency key of an explicit peer send (`msg_...`). */
  readonly messageId?: string;
}

export interface SendResult {
  readonly sent: string[];
  readonly skipped: string[];
  /** Echo of the archived idempotency key (absent in legacy mode). */
  readonly messageId?: string;
}

/** Peer idempotency keys: `msg_` + url-safe characters, so the same value can
 *  be handed to OpenCode's prompt id if that is ever proven idempotent. */
const PEER_MESSAGE_ID = /^msg_[A-Za-z0-9_-]+$/;

/** Everything a peer may never compose: the two authority prefixes. Matched
 *  case-insensitively and tolerating spacing (`boss:`, `BOSS:`, `Human :`). */
const RESERVED_PREFIX = /^(human|boss)\s*:/i;

function senderOf(name: string): PromptSender {
  if (name === 'human') return { kind: 'human' };
  if (name === BOSS) return { kind: 'boss' };
  return { kind: 'peer', name };
}

export class ChatService {
  /** Pending reply attribution, keyed by the RECIPIENT session: set when the
   *  lobby's own prompt is observed arriving on that session's inbox (the
   *  prefix names the sender), consumed by the first captured reply. A reply
   *  with no pending entry falls back to boss - never to a stale peer. */
  readonly #pendingReplyTo = new Map<string, string>();
  /** Sessions whose arm could not be cleared (SQLITE_BUSY). The arm must fail
   *  OPEN, so the next capture archives instead of being suppressed. */
  readonly #unclearedArms = new Set<string>();
  /** Single-flight wake serialization (work order Task 1.3): every wakeBoss()
   *  attempt queues behind the previous one, so the read → prompt → bookmark
   *  sequence never overlaps itself (two overlapping wakes sliced the same
   *  unread rows twice — the Nov-16 greg/porty duplicate; bridge.mjs:119-124
   *  advanced the bookmark only after prompting). */
  #wakeChain: Promise<void> = Promise.resolve();
  /** Ingest serialization (final-review fix round 2). The ingest retry loop
   *  reads, temporarily caps and restores the SHARED connection's
   *  busy_timeout; with the synchronous nap gone, two overlapping saves could
   *  interleave there — one reading the other's temporary cap as its
   *  "original" and restoring that lowered value for good. Every #save queues
   *  behind the previous one, so each critical section sees the configured
   *  value. Waiters AWAIT (async queue); nothing blocks the event loop. */
  #ingestChain: Promise<unknown> = Promise.resolve();
  readonly #store: ChatDeps['store'];
  readonly #registry: ChatDeps['registry'];
  readonly #ports: ChatDeps['ports'];
  readonly #busyRetryBudgetMs: number;
  /** Allowlist reader (fresh per send). Undefined = peer messaging is off. */
  readonly #readAllowlist: ChatDeps['readAllowlist'];

  constructor(deps: ChatDeps) {
    this.#store = deps.store;
    this.#registry = deps.registry;
    this.#ports = deps.ports;
    this.#busyRetryBudgetMs = deps.busyRetryBudgetMs ?? BUSY_RETRY_BUDGET_MS;
    this.#readAllowlist = deps.readAllowlist;
  }

  // --- Queries --------------------------------------------------------------

  /** GET /api/messages (bridge.mjs:266-286): view routing; project views
   *  resolve their agent member names from the per-request registry read. */
  async queryMessages(query: MessageQuery): Promise<MessagePage> {
    let agents: string[] = [];
    if (query.view.startsWith('project:')) {
      const registry = await this.#registry.read();
      agents = registry.agents
        .filter((a) => a.project === query.view.slice('project:'.length))
        .map((a) => a.name);
    }
    return this.#store.query({ ...query, agents });
  }

  /** GET /api/last-activity (bridge.mjs:288-294): per-view latest ts over the
   *  registry's agent names; project views aggregate client-side. */
  async lastActivity(): Promise<Record<string, string | null>> {
    const registry = await this.#registry.read();
    return this.#store.lastActivity(registry.agents.map((a) => a.name));
  }

  // --- Capture (the bridge's listener flow, bridge.mjs:166-204) --------------

  /** Consumes one Phase 3 NormalizedEvent: boss-only capture for human input,
   *  observed-inbound reply attribution, the peer delivery-turn suppressor, and
   *  the boss wake trigger (peer-to-peer traffic does not wake boss). */
  async handleEvent(event: NormalizedEvent): Promise<void> {
    if (event.kind === 'inbox') {
      // A delivered prompt is the session's next-turn boundary: whatever a
      // peer send armed is over (the body is already archived). The event is
      // an ENQUEUE, so it can also arrive while the send's own turn is still
      // running - that only costs a duplicate transcript row, never a lost
      // reply, which is the trade-off this design accepts.
      if (event.to !== BOSS) {
        this.#clearArmed(event.sessionId);
        // Agent session input: attribute the NEXT captured reply to the sender
        // the lobby composed into the prefix. O02: typing straight into a
        // desktop session emits no event at all, so it cannot set this.
        const sender = parsePromptSender(event.body);
        if (sender !== null) {
          this.#pendingReplyTo.set(event.to, sender.kind === 'peer' ? sender.name : sender.kind);
        } else {
          // An unprefixed inbound (e.g. a direct OpenCode prompt, which
          // bypasses the lobby) is not the peer prompt we were waiting on:
          // drop the pending entry so the reply fails toward boss, never
          // toward a stale peer.
          this.#pendingReplyTo.delete(event.to);
        }
        return;
      }
      // Skip the synthetic echoes (already logged by /send) and the bridge's
      // own wake prompt (plain, or carrying the unread slice) — only genuine
      // human input logs. A real message that merely BEGINS with the wake text
      // still captures (bridge.mjs:172-178).
      if (event.body === WAKE_PROMPT || event.body.startsWith(WAKE_PROMPT + '\n\n')) return;
      await this.#save({
        ts: event.ts,
        from: 'human',
        to: BOSS,
        body: event.body,
        sessionId: event.sessionId,
      }, true);
      return;
    }

    // Reply capture (session.text.ended, bridge.mjs:186-204). Boss replies
    // are captured UNCONDITIONALLY (Boss ruling 2026-11-19, option (d): the
    // reply to our wake IS the relay the human reads — no wake-echo reply
    // suppression; work order item 1.1 struck).
    if (event.from === BOSS) {
      await this.#save({
        ts: event.ts,
        from: BOSS,
        to: 'human',
        body: event.body,
        sessionId: event.sessionId,
      }, true);
      return;
    }
    // A peer send's own delivery turn is transcript, not a message: its body
    // was archived byte-for-byte when /send was accepted. A read failure here
    // must not lose a capture - archive instead, and the next inbound clears.
    let suppressed = false;
    try {
      suppressed = this.#store.isCaptureSuppressed(event.sessionId);
    } catch (err) {
      console.warn('[chat] capture-suppression read failed (archiving):', err);
    }
    if (suppressed && this.#unclearedArms.delete(event.sessionId)) {
      // A previous clear failed: fail OPEN. Archive this reply and try the
      // clear again, rather than suppressing a message that was never sent.
      this.#clearArmed(event.sessionId);
      suppressed = false;
    }
    if (suppressed) {
      // Consume the arm: this one transcript is skipped, and the next turn is
      // archived normally (a multi-segment turn's later segments therefore
      // archive - duplicate noise, never a lost reply).
      this.#clearArmed(event.sessionId);
      return;
    }
    // Single-use attribution: the prompt actually being answered wins, and a
    // reply with no observed inbound falls back to boss (never to a stale peer).
    const pending = this.#pendingReplyTo.get(event.from);
    this.#pendingReplyTo.delete(event.from);
    const replyTo = pending ?? BOSS;
    await this.#save({
      ts: event.ts,
      from: event.from,
      to: replyTo,
      body: event.body,
      sessionId: event.sessionId,
    }, true);
    // Wake boss only when the row will actually be IN the slice - i.e. the
    // reply addresses boss. A reply to the human (or a peer) is archived but
    // must not wake anyone: the wake would carry nothing.
    if (replyTo === BOSS) {
      void this.wakeBoss();
    }
  }

  /** One atomic ingest: message row + message.created event commit together
   *  through the Phase 2 bus transaction (fan-out happens only after commit,
   *  in persisted-id order — the bus contract). `dedupEventCapture` is passed
   *  ONLY by the OpenCode-listener capture paths (inbox items, session
   *  replies); explicit inserts (/send fan-out, /webhook) never dedup.
   *
   *  SQLITE_BUSY must never silently drop a capture (review round 3): every
   *  attempt waits on the write lock under a SHORT driver busy_timeout cap, the
   *  attempts are separated by an ASYNC nap (the event loop keeps running —
   *  timers, HTTP, SSE — final-review fix 2), and the transaction retries until
   *  the budget is exhausted. A busy loser RETRIES — once the lock frees it
   *  either inserts (no duplicate committed meanwhile) or skips (a duplicate
   *  WAS committed meanwhile): dedup-skip and busy-retry are different
   *  outcomes. Only a skip leaves the event log alone (no message.created —
   *  nothing was created, final-review fix 4).
   *
   *  Only after the ENTIRE budget is exhausted is the capture given up with a
   *  LOUD `CAPTURE LOST` error carrying the row's IDENTIFYING metadata (from,
   *  to, ts, sessionId, body length) and NOT the body — message content must
   *  never reach the logs (final-review fix 3; the event-stream handler logs
   *  and continues, so that log is the only record of the lost event).
   *
   *  The deadline is re-measured AFTER the nap, then the attempt's driver wait
   *  is capped to the remaining budget (never above the per-attempt cap), so
   *  the total wall-clock ≈ the budget. The capped retries restore the
   *  connection's saved busy_timeout when they finish (success or exhaustion) —
   *  the connection is shared with the registry mirror transactions, which have
   *  no retry loop of their own — and the whole read-cap-restore section is
   *  serialized through #ingestChain (final-review fix round 2): a concurrent
   *  save can never snapshot another save's temporary cap as its "original"
   *  value. */
  async #save(row: NewMessage, dedupEventCapture = false): Promise<WireMessageRow> {
    // Serialize, never block: a second save queues behind the in-flight one
    // and awaits it (the chain only orders; each caller still sees its OWN
    // outcome via `run`).
    const run = this.#ingestChain.then(() => this.#saveAttempt(row, dedupEventCapture));
    this.#ingestChain = run.catch(() => {});
    return run;
  }

  /** One serialized ingest attempt loop (see #save: atomicity, retry budget,
   *  CAPTURE LOST, dedup-skip semantics). */
  async #saveAttempt(row: NewMessage, dedupEventCapture = false): Promise<WireMessageRow> {
    const budget = this.#busyRetryBudgetMs;
    const deadline = Date.now() + budget;
    // Saved BEFORE any cap: the capped attempts must leave the shared
    // connection's busy_timeout exactly as they found it.
    const originalTimeout = this.#store.busyTimeout();
    let napMs = 25;
    let attempts = 0;
    let lastBusyErr: unknown;
    const exhaust = (): never => {
      console.error(
        `[chat] CAPTURE LOST: ingest still SQLITE_BUSY after ${attempts} attempt(s), ${budget}ms budget exhausted — from=${row.from} to=${row.to} ts=${row.ts} sessionId=${row.sessionId} bodyLength=${row.body.length} dedupEventCapture=${dedupEventCapture}`,
        lastBusyErr,
      );
      throw lastBusyErr;
    };
    try {
      for (;;) {
        if (attempts > 0) {
          if (Date.now() >= deadline) exhaust(); // no budget left: do not even nap
          // Backoff FIRST, and ASYNC so the event loop runs while another
          // connection holds the lock; the nap is clipped to the deadline.
          await sleep(Math.min(napMs, Math.max(0, deadline - Date.now())));
          napMs = Math.min(napMs * 2, 500);
          if (Date.now() >= deadline) exhaust(); // nap spent the last of the budget
        }
        const remaining = deadline - Date.now();
        // Bound THIS attempt's synchronous driver wait: the whole point is
        // that a contended capture never parks the process for the budget.
        this.#store.setBusyTimeout(Math.max(1, Math.min(originalTimeout, remaining, BUSY_ATTEMPT_CAP_MS)));
        attempts++;
        try {
          return this.#ports.bus.transaction((persist) => {
            const { row: wire, inserted } = this.#store.insert(row, dedupEventCapture);
            if (inserted) persist('message.created', wire);
            return wire;
          });
        } catch (err) {
          if (!isBusyError(err)) throw err; // non-busy errors fail fast, unchanged
          lastBusyErr = err;
        }
      }
    } finally {
      // Never leave a lowered busy_timeout on the shared connection (the
      // registry mirror writes through it without a retry loop).
      this.#store.setBusyTimeout(originalTimeout);
    }
  }

  // --- Boss wake (bridge.mjs:98-130) -----------------------------------------

  /** Wake the boss with an inline unread slice. Token-free coalescing first
   *  (a pending user input item means a wake is already queued — zero tokens);
   *  the slice excludes what the boss session already has natively AND
   *  peer-to-peer traffic; the bookmark advances through the whole unread
   *  SNAPSHOT taken before the enqueue await (so filtered rows are not
   *  re-read, and rows landing during the await stay unread); an empty slice
   *  sends the bare wake prompt. */
  async wakeBoss(): Promise<void> {
    // Single-flight wake (work order Task 1.3): a second wake call queues
    // behind the in-flight one and RE-CHECKS (coalescing + unread) after it
    // completes, instead of racing it. Chosen over claim-at-read because a
    // crash between claim and prompt would silently LOSE boss-wake rows;
    // the worst case here is the status-quo duplicate (a crash between
    // prompt and markSeen), never loss.
    const run = this.#wakeChain.then(() => this.#wakeAttempt());
    this.#wakeChain = run.catch(() => {}); // the chain only serializes; failures are logged inside
    return run;
  }

  /** One serialized wake attempt (bridge.mjs:98-130). Token-free coalescing
   *  first (a pending user input item means a wake is already queued — zero
   *  tokens); the slice excludes what the boss session already has natively
   *  AND peer-to-peer traffic. The bookmark advances through the whole unread
   *  SNAPSHOT taken before the enqueue await (not only the slice: filtered
   *  rows would otherwise be re-read on every wake), so rows arriving after
   *  the snapshot stay unread. An empty slice sends the bare wake prompt. */
  async #wakeAttempt(): Promise<void> {
    // bridge.mjs:99-100 — no effective server URL → cannot wake, loud log.
    if (!this.#ports.prompts.isAvailable()) {
      console.error('[chat] No OpenCode server URL; cannot wake boss.');
      return;
    }
    let bossSession: string;
    try {
      const registry = await this.#registry.read();
      if (registry.boss === null) return; // fresh clone: no boss configured
      bossSession = registry.boss.session;
    } catch (err) {
      console.error('[chat] wake skipped: registry unreadable:', err);
      return;
    }
    try {
      if (await this.#ports.sessions.hasPendingUserInput(bossSession)) {
        console.log('[chat] Boss wake already pending, skipping.');
        return;
      }
      const unread = this.#store.unread(BOSS);
      if (unread.length === 0) {
        // Nothing new since the last wake: a second wake fired by a burst of
        // replies would otherwise prompt the boss with an empty slice.
        return;
      }
      const rows = wakeSliceRows(unread);
      const text = composeWakePrompt(
        rows.map((r) => ({ time: r.time, from: r.from, to: r.to, text: r.text })),
      );
      await this.#ports.prompts.prompt(bossSession, text);
      // Bookmark through the whole unread SNAPSHOT, not just the slice: rows
      // deliberately kept out of the slice (boss's own, and peer-to-peer
      // traffic) would otherwise be re-read and re-filtered on every wake.
      // Snapshotting before the await keeps rows arriving meanwhile unread.
      const last = unread.at(-1);
      if (last !== undefined) this.#store.markSeen(BOSS, last.id);
      console.log('[chat] Boss wake prompt enqueued.');
    } catch (err) {
      console.error('[chat] Wake failed:', err);
    }
  }

  // --- /send fan-out (bridge.mjs:390-443) ------------------------------------

  /** Resolve `message` to its recipients and deliver it.
   *
   *  Legacy mode (no credential -> `authenticated` false): `from` is the body
   *  value, human | boss only, unchanged fan-out semantics (bridge.mjs:390-443).
   *
   *  Peer mode (a credential decided `from`): the sender may be an agent. A
   *  peer sends to exactly ONE recipient, must be allowed by the contact
   *  allowlist, and carries a `msg_...` idempotency key. Its exact body is
   *  archived BEFORE delivery (single writer), the row arms the sender-turn
   *  capture suppressor, and the delivery state tracks confirmation. */
  async sendMessage(input: SendInput): Promise<SendResult> {
    const text = (input.message || '').trim();
    if (!text) throw new AppError(400, 'invalid_input', 'message is required');
    const authenticated = input.authenticated === true;
    const senderName = input.from ?? (authenticated ? '' : 'boss');
    if (!authenticated) {
      if (senderName !== 'human' && senderName !== 'boss') {
        throw new AppError(400, 'invalid_sender', "from must be 'human' or 'boss'");
      }
    } else if (senderName === '') {
      throw new AppError(401, 'unauthorized', 'authenticated sender required');
    }
    // bridge.mjs:399-400 — the bridge fails fast (500) when no OpenCode server
    // URL was discovered, BEFORE resolving targets. Neutral availability
    // check; same status, same message semantics.
    if (!this.#ports.prompts.isAvailable()) {
      throw new AppError(500, 'upstream_unavailable', 'OpenCode server URL not discovered');
    }
    const registry = await this.#registry.read();
    const sender = senderOf(senderName);
    if (sender.kind === 'peer') {
      return this.#sendPeer(sender, input.to, text, registry, input.messageId);
    }
    return this.#sendFromAuthority(senderName, sender, input.to, text, registry, authenticated);
  }

  /** Human | Boss send: existing fan-out, plus the role policy when the sender
   *  authenticated (every resolved recipient role must be permitted). */
  async #sendFromAuthority(
    senderName: string,
    sender: PromptSender,
    to: SendInput['to'],
    text: string,
    registry: RegistrySnapshot,
    authenticated: boolean,
  ): Promise<SendResult> {
    const senderRole = authenticated ? senderName : null;
    const { entries: targets, human } = await this.#resolveRecipients(
      to,
      senderRole,
      registry,
      authenticated,
    );
    if (targets.length === 0 && human) {
      // `to: 'human'` from an authority sender has no session and no agent:
      // report the legacy no-target status instead of a silent empty success.
      throw new AppError(404, 'no_targets', `no matching agents for: ${JSON.stringify(to)}`);
    }
    const promptText = composePrompt(sender, text);
    // Attribution is NOT recorded here: it is set when this prompt is observed
    // arriving on the target session's inbox, so a queued prompt cannot be
    // overwritten by a later send before it is answered.
    const results = await Promise.allSettled(
      targets.map((a) => this.#ports.prompts.prompt(a.session, promptText)),
    );
    const sent: string[] = [];
    const skipped: string[] = [];
    results.forEach((r, i) => {
      const name = targets[i]?.name;
      if (name === undefined) return; // unreachable: results map 1:1 to targets
      (r.status === 'fulfilled' ? sent : skipped).push(name);
    });
    if (sent.length > 0) {
      await this.#save({
        ts: new Date().toISOString(),
        from: senderName,
        to: sent.join(', '),
        body: text,
        sessionId: null,
      });
    }
    return { sent, skipped };
  }

  /** Resolve a `to` value into recipients, applying the ROLE policy.
   *
   *  Precedence per token: `human`, `boss`, then a ROLE name (all its holders),
   *  then an agent name. Policy is enforced only when `enforcePolicy` is set
   *  (authenticated callers); the legacy unauthenticated path keeps its old
   *  name/`all` behaviour. A role-less agent is unaddressable. */
  async #resolveRecipients(
    to: SendInput['to'],
    senderRole: string | null,
    registry: RegistrySnapshot,
    enforcePolicy: boolean,
  ): Promise<{ entries: RegistryEntry[]; human: boolean }> {
    const allowlist = enforcePolicy ? await this.#allowlist() : {};
    const permit = (recipientRole: string | null, label: string): void => {
      if (!enforcePolicy) return;
      if (senderRole === null) {
        // Fail CLOSED: a policy check with no sender role is a bug, never a pass.
        throw new AppError(403, 'no_role', 'sender has no role and cannot be checked against the policy');
      }
      if (recipientRole === null) {
        throw new AppError(403, 'no_role', `${label} has no role and cannot be addressed`);
      }
      if (!isPairAllowed(allowlist, senderRole, recipientRole)) {
        throw new AppError(403, 'forbidden_pair', `${senderRole} may not send to ${recipientRole} (${label})`);
      }
    };
    const push = (entries: RegistryEntry[], agent: RegistryEntry): void => {
      // Identity is the SESSION: duplicate agent names are valid registry
      // content and must each be prompted; the same session twice is not.
      if (!entries.some((e) => e.session === agent.session)) entries.push(agent);
    };
    /** Explicit lists follow REGISTRY order, like the legacy fan-out. */
    const ordered = (entries: RegistryEntry[]): RegistryEntry[] =>
      [...entries].sort((a, b) => registry.agents.indexOf(a) - registry.agents.indexOf(b));

    if (to === 'all') {
      const entries: RegistryEntry[] = [];
      for (const agent of registry.agents) {
        if (enforcePolicy) {
          if (agent.role === undefined || senderRole === null) continue;
          if (!isPairAllowed(allowlist, senderRole, agent.role)) continue;
        }
        push(entries, agent);
      }
      if (entries.length === 0) {
        throw new AppError(404, 'no_targets', `no matching agents for: ${JSON.stringify(to)}`);
      }
      return { entries, human: false };
    }

    const tokens = Array.isArray(to) ? to : [to];
    if (tokens.length === 0) {
      // Legacy pin: an EMPTY array is the bridge's no-targets 404, message
      // text included (bridge.mjs:405-412).
      throw new AppError(404, 'no_targets', `no matching agents for: ${JSON.stringify(to)}`);
    }
    const entries: RegistryEntry[] = [];
    let human = false;
    for (const token of tokens) {
      if (token === 'human') {
        permit('human', 'human');
        human = true;
        continue;
      }
      if (token === BOSS) {
        if (registry.boss === null) {
          throw new AppError(404, 'no_targets', `no matching agents for: ${JSON.stringify(token)}`);
        }
        permit('boss', 'boss');
        push(entries, registry.boss);
        continue;
      }
      const holders = agentsWithRole(registry, token);
      if (holders.length > 0) {
        permit(token, `role ${token}`);
        for (const holder of holders) push(entries, holder);
        continue;
      }
      // Agent NAME: every entry with that name (duplicate names are valid
      // registry content and each session must be prompted).
      const named = registry.agents.filter((a) => a.name === token);
      if (named.length === 0) {
        throw new AppError(404, 'no_targets', `no matching agents for: ${JSON.stringify(token)}`);
      }
      for (const agent of named) {
        permit(agent.role ?? null, agent.name);
        push(entries, agent);
      }
    }
    return { entries: ordered(entries), human };
  }

  /** Peer send: archive first (exact body + idempotency key + armed
   *  suppressor), then prompt. Recipients are resolved by ROLE: a role token
   *  fans out to every holder; `human` is archive-only (no session). */
  async #sendPeer(
    sender: { readonly kind: 'peer'; readonly name: string },
    to: SendInput['to'],
    text: string,
    registry: RegistrySnapshot,
    messageId: string | undefined,
  ): Promise<SendResult> {
    if (RESERVED_PREFIX.test(text)) {
      throw new AppError(400, 'reserved_prefix', 'a peer message may not begin with "Human:" or "Boss:"');
    }
    if (to === 'all' || Array.isArray(to)) {
      throw new AppError(403, 'forbidden_pair', 'a peer sends to one recipient or role (no "all", no list)');
    }
    if (messageId === undefined || !PEER_MESSAGE_ID.test(messageId)) {
      throw new AppError(400, 'invalid_message_id', 'messageId is required for peer sends (format msg_<id>)');
    }
    const senderEntries = registry.agents.filter((a) => a.name === sender.name);
    const senderEntry = senderEntries[0];
    if (senderEntry === undefined) {
      throw new AppError(403, 'unknown_sender', `sender is not a registered agent: ${sender.name}`);
    }
    // A duplicated name cannot be told apart: two sessions, one identity. The
    // registry still LISTS duplicates (bridge compatibility), but a peer send
    // from an ambiguous name would arm the wrong turn, so refuse it.
    if (senderEntries.length > 1) {
      throw new AppError(409, 'ambiguous_sender', `agent name is not unique in the registry: ${sender.name}`);
    }
    // Defence in depth: the principal file is validated at load, but the
    // invariant "a peer name cannot forge a prefix line" is enforced where the
    // prefix is composed, not only where the file is read.
    if (!isComposablePeerName(sender.name)) {
      throw new AppError(403, 'invalid_sender', `sender name cannot be composed into a peer prefix: ${JSON.stringify(sender.name)}`);
    }
    const senderRole = roleOfPrincipal(sender.name, registry);
    if (senderRole === null) {
      throw new AppError(403, 'no_role', `sender has no role and cannot send: ${sender.name}`);
    }
    // Idempotency: a retried send returns the archived row's recipients and
    // prompts nothing again. The lookup is SENDER-SCOPED - keys are client
    // chosen, so one agent must not claim another's.
    const existing = this.#store.findOwnMessage(messageId, sender.name);
    if (existing !== null) {
      const targets = existing.message.to === null ? [] : existing.message.to.split(', ');
      // `sent` means DELIVERED: a row still pending is honestly skipped (the
      // startup reconciliation owns the one retry).
      return existing.deliveryState === 1
        ? { sent: targets, skipped: [], messageId }
        : { sent: [], skipped: targets, messageId };
    }
    const { entries, human } = await this.#resolveRecipients(to, senderRole, registry, true);
    const labels = [...(human ? ['human'] : []), ...entries.map((e) => e.name)];
    const delivered = entries.length > 0;
    // The arm belongs to the SENDER's turn, not to the recipient: a peer send
    // to `human` also ends a turn whose transcript must not be archived twice.
    let row: { id: number };
    try {
      row = await this.#save({
        ts: new Date().toISOString(),
        from: sender.name,
        to: labels.join(', '),
        body: text,
        sessionId: senderEntry.session,
        messageId,
        captureSuppressed: true,
        deliveryState: delivered ? 0 : 1,
      });
    } catch (err) {
      // A concurrent instance may have won the unique-index race with the
      // same key: that is the idempotent hit, not a failure.
      if (!this.#store.isMessageIdConflict(err)) throw err;
      const raced = this.#store.findOwnMessage(messageId, sender.name);
      if (raced === null) throw err;
      const targets = raced.message.to === null ? [] : raced.message.to.split(', ');
      return raced.deliveryState === 1
        ? { sent: targets, skipped: [], messageId }
        : { sent: [], skipped: targets, messageId };
    }
    if (!delivered) return { sent: ['human'], skipped: [], messageId };
    const promptText = composePrompt(sender, text);
    const results = await Promise.allSettled(
      entries.map((entry) => this.#ports.prompts.prompt(entry.session, promptText)),
    );
    const sent: string[] = [];
    const skipped: string[] = [];
    results.forEach((r, i) => {
      const name = entries[i]?.name;
      if (name === undefined) return;
      (r.status === 'fulfilled' ? sent : skipped).push(name);
    });
    if (skipped.length > 0) {
      // Archived but not fully delivered: the row keeps delivery_state 0, so
      // the startup reconciliation retries it once. Log the cause - an operator
      // otherwise sees only "skipped".
      console.warn(`[chat] peer delivery skipped (${sender.name} -> ${skipped.join(', ')})`);
    } else {
      await this.#serialized(() => this.#store.markDeliverySent(row.id));
    }
    return { sent, skipped, messageId };
  }

  async #allowlist(): Promise<PeerAllowlist> {
    return this.#readAllowlist === undefined ? {} : this.#readAllowlist();
  }

  /** Runs a store call behind the ingest chain: the ingest retry loop
   *  temporarily LOWERS the shared connection's busy_timeout, so a call that
   *  jumps the queue can fail as busy. Ordering alone fixes it - the lowered
   *  value is restored when the running attempt finishes. */
  #serialized<T>(fn: () => T): Promise<T> {
    const run = this.#ingestChain.then(() => fn());
    this.#ingestChain = run.catch(() => {});
    return run;
  }

  /** Ends the arming on a session (turn boundary reached). A failed clear is
   *  logged, remembered for this process, and retried on the next capture -
   *  the arm must fail OPEN: a stale arm would suppress a real reply. */
  #clearArmed(sessionId: string): void {
    try {
      this.#store.clearCaptureSuppressed(sessionId);
      this.#unclearedArms.delete(sessionId);
    } catch (err) {
      this.#unclearedArms.add(sessionId);
      console.warn('[chat] capture-suppression clear failed (failing open; retried on next capture):', err);
    }
  }

  /** One startup pass over peer rows archived but never confirmed delivered.
   *  Converts a silent loss (crash between archive and prompt) into
   *  at-least-once delivery: at most ONE duplicate prompt per row, ever. Rows
   *  whose recipient no longer resolves are marked retried, not retried
   *  forever. Never throws: startup must not die for a retry. */
  async reconcileDeliveries(): Promise<void> {
    // No turn can be in flight across a restart, so every surviving arm is
    // stale: clear them all before anything else. This removes the only path
    // where a crash could let an arm suppress a real reply.
    try {
      this.#store.clearAllCaptureSuppressed();
    } catch (err) {
      console.warn('[chat] clearing stale capture arms failed:', err);
    }
    const pending = this.#store.unconfirmedPeerDeliveries();
    if (pending.length === 0) return;
    if (!this.#ports.prompts.isAvailable()) {
      console.warn(`[chat] delivery reconciliation skipped (${pending.length} pending): OpenCode server URL not discovered`);
      return;
    }
    const registry = await this.#registry.read();
    let sent = 0;
    let failed = 0;
    for (const row of pending) {
      // A fan-out row names several recipients; `human` has no session. The
      // row is confirmed only when every reachable recipient accepts.
      const names = (row.to ?? '').split(', ').filter((n) => n !== '' && n !== 'human');
      const sessions: string[] = [];
      for (const name of names) {
        const entry = name === BOSS ? (registry.boss ?? undefined) : undefined;
        if (entry !== undefined) {
          sessions.push(entry.session);
          continue;
        }
        // Duplicate names are possible; re-prompt every session with it.
        for (const held of registry.agents.filter((a) => a.name === name)) sessions.push(held.session);
      }
      if (sessions.length === 0) {
        this.#store.markDeliveryRetried(row.id);
        failed += 1;
        continue;
      }
      try {
        await Promise.all(sessions.map((session) => this.#ports.prompts.prompt(session, composePrompt(senderOf(row.from), row.text))));
        await this.#serialized(() => this.#store.markDeliverySent(row.id));
        sent += 1;
      } catch (err) {
        console.warn(`[chat] reconciliation delivery failed (${row.from} -> ${row.to}):`, err);
        this.#store.markDeliveryRetried(row.id);
        failed += 1;
      }
    }
    console.log(`[chat] delivery reconciliation: ${sent} sent, ${failed} given up (one attempt each)`);
  }

  // --- /webhook legacy capture (bridge.mjs:342-363) ---------------------------

  /** The legacy capture path with the bridge's TRUTHINESS semantics
   *  (bridge.mjs:346-361) — `body` is the JSON.parse result, ANY JSON shape:
   *  it is DESTRUCTURED like the bridge (`const { from, message } = ...`),
   *  so only `null` is special (destructuring throws → the bridge's blanket
   *  catch); every other shape yields undefined props. `(message ||
   *  "").trim()` decides the 400 (`:347-348`); a truthy non-string message
   *  throws at `.trim()` → blanket catch. `from \|\| "unknown"` passes ANY
   *  truthy JSON type to the store as-is (`:351`) — SQLite TEXT affinity
   *  coerces truthy scalars IDENTICALLY on node:sqlite (legacy) and
   *  better-sqlite3 (verified: `123` → `'123.0'` on both), and values the
   *  driver cannot bind (booleans/objects/arrays) reject at the store →
   *  blanket-catch 400 on both sides. The wake fires only after a successful
   *  save, NOT awaited (`:350-357`). */
  async webhookMessage(body: unknown): Promise<{ status: 'ok' }> {
    let from: unknown;
    let message: unknown;
    try {
      ({ from, message } = body as Record<PropertyKey, unknown>); // ToObject: throws only on null/undefined (bridge.mjs:346)
    } catch {
      throw new AppError(400, 'invalid_json', 'Invalid JSON');
    }
    // Bridge order (bridge.mjs:347-348): falsy message (any type) →
    // "message is required"; truthy non-string → .trim() throws → blanket
    // catch → "Invalid JSON"; whitespace-only → "message is required".
    if (!message) {
      throw new AppError(400, 'invalid_input', 'message is required');
    }
    if (typeof message !== 'string') {
      // bridge.mjs:347 — a truthy non-string message throws at .trim() → the
      // bridge's blanket catch (:359-361) → 400 "Invalid JSON".
      throw new AppError(400, 'invalid_json', 'Invalid JSON');
    }
    const text = message.trim();
    if (!text) {
      throw new AppError(400, 'invalid_input', 'message is required');
    }
    try {
      await this.#save({
        ts: new Date().toISOString(),
        from: webhookSender(from),
        to: null,
        body: text,
        sessionId: null,
      });
    } catch (err) {
      console.error('[chat] webhook save failed:', err);
      // shortcut: replicates bridge.mjs blanket-catch misclassification (save errors reported as Invalid JSON) for cutover parity — revisit post-cutover once webhook callers are confirmed
      throw new AppError(400, 'invalid_json', 'Invalid JSON');
    }
    void this.wakeBoss();
    return { status: 'ok' };
  }

  // --- /prompt to boss (bridge.mjs:365-388) ----------------------------------

  /** Webchat: prompt the boss session directly. Logging is handled by the
   *  event listener's inbox capture — the route stores nothing itself
   *  (bridge.mjs:374-383). */
  async promptBoss(message: string): Promise<{ status: 'ok' }> {
    const text = (message || '').trim();
    if (!text) throw new AppError(400, 'invalid_input', 'message is required');
    // bridge.mjs:372-373 — the bridge checks the server URL before anything
    // registry-related (neutral availability check, same status + message).
    if (!this.#ports.prompts.isAvailable()) {
      throw new AppError(500, 'upstream_unavailable', 'OpenCode server URL not discovered');
    }
    const registry = await this.#registry.read();
    if (registry.boss === null) {
      throw new AppError(500, 'registry_unavailable', 'boss session not configured (agents.json missing boss entry)');
    }
    try {
      await this.#ports.prompts.prompt(registry.boss.session, text);
    } catch {
      throw new AppError(500, 'prompt_failed', 'Failed to prompt the boss session');
    }
    return { status: 'ok' };
  }

  // --- Exposed for wiring ------------------------------------------------------

  /** The registry snapshot for callers that need it (none today; Phase 5). */
  async registrySnapshot(): Promise<RegistrySnapshot> {
    return this.#registry.read();
  }
}
