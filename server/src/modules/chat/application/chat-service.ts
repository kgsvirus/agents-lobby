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
import type { ChatDeps, RegistrySnapshot } from './ports.js';

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
}

export class ChatService {
  /** Who last prompted each agent (human | boss) — an agent's reply is routed
   *  to its last prompter, default "boss" when history is unknown
   *  (bridge.mjs:51-53,195; in-memory, lost on restart, fallback preserved). */
  readonly #lastPromptFrom = new Map<string, string>();
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

  constructor(deps: ChatDeps) {
    this.#store = deps.store;
    this.#registry = deps.registry;
    this.#ports = deps.ports;
    this.#busyRetryBudgetMs = deps.busyRetryBudgetMs ?? BUSY_RETRY_BUDGET_MS;
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

  /** Consumes one Phase 3 NormalizedEvent: boss-only filter + echo suppression
   *  for human input; reply capture with lastPromptFrom routing and the boss
   *  wake trigger for agent replies. */
  async handleEvent(event: NormalizedEvent): Promise<void> {
    if (event.kind === 'inbox') {
      // Boss session only — the normalized `to` is the resolved session-owner
      // name, so the domain comparison is against the boss identity.
      if (event.to !== BOSS) return;
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
    const replyTo = this.#lastPromptFrom.get(event.from) ?? BOSS;
    await this.#save({
      ts: event.ts,
      from: event.from,
      to: replyTo,
      body: event.body,
      sessionId: event.sessionId,
    }, true);
    // An agent answered — wake the boss (coalesced, same as webhook; the
    // bridge does not await it, bridge.mjs:203).
    void this.wakeBoss();
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
   *  the slice excludes what the boss session already has natively; the
   *  bookmark advances only THROUGH the slice so rows inserted during the
   *  enqueue await stay unread; an empty slice sends the bare wake prompt and
   *  moves no bookmark. */
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
   *  tokens); the slice excludes what the boss session already has natively;
   *  the bookmark advances only THROUGH the slice so rows inserted during
   *  the enqueue await stay unread; an empty slice sends the bare wake
   *  prompt and moves no bookmark. */
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
      const rows = wakeSliceRows(this.#store.unread(BOSS));
      const text = composeWakePrompt(
        rows.map((r) => ({ time: r.time, from: r.from, to: r.to, text: r.text })),
      );
      await this.#ports.prompts.prompt(bossSession, text);
      // Bookmark only through the captured slice — a no-arg markSeen here
      // could swallow rows arriving during the enqueue await.
      const last = rows.at(-1);
      if (last !== undefined) this.#store.markSeen(BOSS, last.id);
      console.log('[chat] Boss wake prompt enqueued.');
    } catch (err) {
      console.error('[chat] Wake failed:', err);
    }
  }

  // --- /send fan-out (bridge.mjs:390-443) ------------------------------------

  /** Fan out `message` to the resolved targets: `to === 'all'` → every registry
   *  agent; otherwise exact-name or array-membership match. One prompt per
   *  target; lastPromptFrom is recorded BEFORE the await (a reply may race the
   *  send, bridge.mjs:416); failures isolate per target (allSettled) →
   *  {sent, skipped}; the saved row's `to` is the JOINED SUCCESSFUL targets
   *  only (bridge.mjs:427-433). */
  async sendMessage(input: SendInput): Promise<{ sent: string[]; skipped: string[] }> {
    const text = (input.message || '').trim();
    if (!text) throw new AppError(400, 'invalid_input', 'message is required');
    const sender = input.from ?? 'boss';
    if (sender !== 'human' && sender !== 'boss') {
      throw new AppError(400, 'invalid_sender', "from must be 'human' or 'boss'");
    }
    // bridge.mjs:399-400 — the bridge fails fast (500) when no OpenCode server
    // URL was discovered, BEFORE resolving targets. Neutral availability
    // check; same status, same message semantics.
    if (!this.#ports.prompts.isAvailable()) {
      throw new AppError(500, 'upstream_unavailable', 'OpenCode server URL not discovered');
    }
    const registry = await this.#registry.read();
    const { to } = input;
    const targets =
      to === 'all'
        ? [...registry.agents]
        : registry.agents.filter(
            (a) => to === a.name || (Array.isArray(to) && to.includes(a.name)),
          );
    if (targets.length === 0) {
      throw new AppError(404, 'no_targets', `no matching agents for: ${JSON.stringify(to)}`);
    }
    const prefix = sender === 'human' ? 'Human' : 'Boss';
    const results = await Promise.allSettled(
      targets.map((a) => {
        this.#lastPromptFrom.set(a.name, sender);
        return this.#ports.prompts.prompt(a.session, `${prefix}: ${text}`);
      }),
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
        from: sender,
        to: sent.join(', '),
        body: text,
        sessionId: null,
      });
    }
    return { sent, skipped };
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
