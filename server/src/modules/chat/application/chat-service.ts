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
  readonly #store: ChatDeps['store'];
  readonly #registry: ChatDeps['registry'];
  readonly #ports: ChatDeps['ports'];

  constructor(deps: ChatDeps) {
    this.#store = deps.store;
    this.#registry = deps.registry;
    this.#ports = deps.ports;
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
      this.#save({
        ts: event.ts,
        from: 'human',
        to: BOSS,
        body: event.body,
        sessionId: event.sessionId,
      });
      return;
    }

    // Reply capture (session.text.ended, bridge.mjs:186-204).
    if (event.from === BOSS) {
      this.#save({
        ts: event.ts,
        from: BOSS,
        to: 'human',
        body: event.body,
        sessionId: event.sessionId,
      });
      return;
    }
    const replyTo = this.#lastPromptFrom.get(event.from) ?? BOSS;
    this.#save({
      ts: event.ts,
      from: event.from,
      to: replyTo,
      body: event.body,
      sessionId: event.sessionId,
    });
    // An agent answered — wake the boss (coalesced, same as webhook; the
    // bridge does not await it, bridge.mjs:203).
    void this.wakeBoss();
  }

  /** One atomic ingest: message row + message.created event commit together
   *  through the Phase 2 bus transaction (fan-out happens only after commit,
   *  in persisted-id order — the bus contract). */
  #save(row: NewMessage): WireMessageRow {
    return this.#ports.bus.transaction((persist) => {
      const wire = this.#store.insert(row);
      persist('message.created', wire);
      return wire;
    });
  }

  // --- Boss wake (bridge.mjs:98-130) -----------------------------------------

  /** Wake the boss with an inline unread slice. Token-free coalescing first
   *  (a pending user input item means a wake is already queued — zero tokens);
   *  the slice excludes what the boss session already has natively; the
   *  bookmark advances only THROUGH the slice so rows inserted during the
   *  enqueue await stay unread; an empty slice sends the bare wake prompt and
   *  moves no bookmark. */
  async wakeBoss(): Promise<void> {
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
      this.#save({
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
      this.#save({
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
