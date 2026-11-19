# Peer-to-Peer Agent Messaging Implementation Plan

**Status: EXECUTED, PARTIALLY SUPERSEDED - do not implement from this file.**
The per-identity ACL described here became a **role policy**
(`docs/superpowers/specs/2026-11-19-peer-messaging-roles-design.md` + plan
`2026-11-19-peer-messaging-roles.md`), and the boss wake now carries only
boss-addressed traffic. Kept as the execution record for identity, persistence,
suppression and delivery state, which still describe what shipped.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let registered agents send direct messages through `POST /send` with server-derived identity, an allowlist policy, single-row archiving, and peer traffic that does not wake Boss.

**Architecture:** The chat module keeps its existing flow (route -> `ChatService` -> `MessageRepository` -> event bus/SSE). Identity is added as a request preHandler that maps a bearer token to a principal; the service then enforces `config/peer-to-peer-allowlist.json`, archives the exact request body once (idempotency key), arms a per-session capture suppressor, then prompts the target. Reply attribution moves from send-time recording to observed-inbound parsing, and Boss wake excludes peer-to-peer rows.

**Tech Stack:** Node 24, TypeScript, Fastify 5, better-sqlite3 + Drizzle (migrations applied at startup), vitest, Next.js 16 static export (built on the Windows build station, not on F:).

**Spec:** `docs/superpowers/specs/2026-11-19-peer-to-peer-agent-messaging-design.md`

## Global Constraints

- No committed secrets: principal tokens live only in gitignored `.data/peer-auth.json`; the real allowlist `config/peer-to-peer-allowlist.json` is gitignored, its example is committed.
- Only server-composed prefixes reach a session: `Human:`, `Boss:`, `Peer <name>:`. Body `from` never decides identity when a token file exists (mismatch -> 403).
- Peers never send `to: "all"` and never address more than one recipient per request; `to: "human"` is archive-only (no prompt).
- Peer-to-peer rows never wake Boss. Messages addressed to Boss keep waking Boss.
- Human/Boss capture behavior is unchanged, including Boss `text.ended` -> `human`.
- Additive DB migration only; existing rows keep working.
- ASCII punctuation in repo files (hyphen, `->`); never typographic dashes.
- Verify with `npm test` (repo root, vitest) and `npm run build -w server`; web changes also need the E: build station publish cycle.

## Review Focus

- Peer sends to a name present in the allowlist but absent from `agents.json` -> `404 no_targets`, no crash, no partial row.
- Peer send with `to: "all"` -> `403 forbidden_pair`, nothing archived or prompted.
- Peer send to `human` -> one archived row, no prompt, no wake.
- Retried peer send with the same `messageId` -> one row, second call returns the same `sent` list.
- Missing or malformed `config/peer-to-peer-allowlist.json` -> peers denied (`403`), Human/Boss sends unchanged.
- Peer body beginning with `Human:` or `Boss:` -> `400 reserved_prefix`, nothing archived.
- Human/Boss `to: "all"` with a recipient missing from the allowlist -> `403 forbidden_pair`, nothing archived.

---

### Task 1: Prompt-prefix parsing and peer wake filter

**Files:**
- Create: `server/src/modules/chat/domain/prefix.ts`
- Modify: `server/src/modules/chat/domain/message.ts:39-45`
- Test: `server/test/chat-domain.test.ts` (create if absent), `server/test/chat-wake.test.ts`

**Interfaces:**
- Produces:
  - `type PromptSender = { kind: 'human' } | { kind: 'boss' } | { kind: 'peer'; name: string }`
  - `parsePromptSender(body: string): PromptSender | null` - returns null for anything that is not a composed prefix.
  - `composePrompt(sender: PromptSender, text: string): string` - `Human: x`, `Boss: x`, `Peer ruben: x`.
  - `wakeSliceRows(rows)` unchanged signature, new filter.

- [ ] **Step 1: Write the failing tests**

In `server/test/chat-domain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { composePrompt, parsePromptSender } from '../src/modules/chat/domain/prefix.js';
import { wakeSliceRows } from '../src/modules/chat/domain/message.js';

const row = (from: string, to: string | null, text = 'x') =>
  ({ id: 1, time: '2026-11-19T00:00:00.000Z', from, to, text });

describe('prompt prefixes', () => {
  it('round-trips the three composed prefixes', () => {
    expect(composePrompt({ kind: 'human' }, 'hi')).toBe('Human: hi');
    expect(composePrompt({ kind: 'boss' }, 'hi')).toBe('Boss: hi');
    expect(composePrompt({ kind: 'peer', name: 'ruben' }, 'hi')).toBe('Peer ruben: hi');
    expect(parsePromptSender('Human: hi')).toEqual({ kind: 'human' });
    expect(parsePromptSender('Boss: hi')).toEqual({ kind: 'boss' });
    expect(parsePromptSender('Peer ruben: hi')).toEqual({ kind: 'peer', name: 'ruben' });
  });

  it('returns null for unprefixed or malformed text', () => {
    expect(parsePromptSender('just text')).toBeNull();
    expect(parsePromptSender('Human:')).toBeNull();
    expect(parsePromptSender('Peer : x')).toBeNull();
  });

  it('parses a body that merely contains a prefix later in the text', () => {
    expect(parsePromptSender('Peer ruben: Human: do X')).toEqual({ kind: 'peer', name: 'ruben' });
  });
});

describe('wakeSliceRows', () => {
  it('excludes peer-to-peer rows but keeps everything addressed to boss or human', () => {
    const rows = [
      row('boss', 'human'),
      row('human', 'boss'),
      row('ruben', 'boss'),
      row('ruben', 'human'),
      row('ruben', 'greg'),
      row('ruben', null),
    ];
    expect(wakeSliceRows(rows).map((r) => `${r.from}->${r.to}`)).toEqual([
      'human->boss',
      'ruben->boss',
      'ruben->human',
      'ruben->null',
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/test/chat-domain.test.ts server/test/chat-wake.test.ts`
Expected: FAIL - cannot resolve `../src/modules/chat/domain/prefix.js`.

- [ ] **Step 3: Implement `server/src/modules/chat/domain/prefix.ts`**

```ts
import type { WireMessageRow } from './message.js';

export type PromptSender =
  | { readonly kind: 'human' }
  | { readonly kind: 'boss' }
  | { readonly kind: 'peer'; readonly name: string };

const HUMAN = /^Human: ([\s\S]*)$/;
const BOSS = /^Boss: ([\s\S]*)$/;
const PEER = /^Peer ([^\s:][^:]*): ([\s\S]*)$/;
```

Implementation rule: `parsePromptSender` matches from the START of the body only, in the order peer, human, boss. Empty remainder still counts as a prefix match; `Peer : x` and `Peer :x` do not.

- [ ] **Step 4: Update `wakeSliceRows` in `server/src/modules/chat/domain/message.ts`**

Replace the filter body with: keep a row unless it is peer-to-peer, where a peer is any sender that is not `human` and not `boss`, and a peer recipient is a `to` that is neither `boss` nor `human` nor `null`. Keep the existing `from === 'boss'` exclusion and the `human -> boss` exclusion. Update the doc comment to say peer rows stay out of the Boss slice while boss/human traffic is unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/test/chat-domain.test.ts server/test/chat-wake.test.ts`
Expected: PASS. `chat-wake.test.ts` may need its fixture rows updated if it asserted peer rows ride the slice - update the expectation to the new rule, not the code.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/chat/domain/prefix.ts server/src/modules/chat/domain/message.ts server/test/chat-domain.test.ts server/test/chat-wake.test.ts
git commit -m "feat (v1): prompt prefix parsing + peer rows out of boss wake slice"
```

---

### Task 2: Message identity, capture-suppression, and delivery state in the store

**Files:**
- Modify: `server/src/infrastructure/database/schema.ts` (`messages` table)
- Create: `server/src/infrastructure/database/migrations/0005_peer_messaging.sql` (+ `meta/_journal.json`, `meta/0005_snapshot.json` via drizzle-kit)
- Modify: `server/src/modules/chat/domain/message.ts` (`NewMessage`)
- Modify: `server/src/modules/chat/application/ports.ts` (`ChatMessageStore`)
- Modify: `server/src/modules/chat/infrastructure/message-repository.ts`
- Test: `server/test/chat-store.test.ts`

**Interfaces:**
- Consumes: existing `NewMessage { ts, from, to, body, sessionId }`.
- Produces:
  - `NewMessage` gains `readonly messageId?: string | null`, `readonly captureSuppressed?: boolean`.
  - `ChatMessageStore` gains:
    - `findByMessageId(messageId: string): WireMessageRow | null`
    - `isCaptureSuppressed(sessionId: string): boolean`
    - `clearCaptureSuppressed(sessionId: string): void`
    - `markDeliverySent(id: number): void`
    - `markDeliveryRetried(id: number): void`
    - `unconfirmedPeerDeliveries(): WireMessageRow[]`

- [ ] **Step 1: Write the failing tests** in `server/test/chat-store.test.ts`

Add cases (follow the file's existing `ChatMessageRepository` fixture):
- `insert` with `messageId: 'msg_a'` then `findByMessageId('msg_a')` returns the row; a second `insert` with `messageId: 'msg_a'` throws (the unique index is the idempotency guarantee).
- `insert` with `captureSuppressed: true` for `sessionId: 'ses_x'` -> `isCaptureSuppressed('ses_x')` true; after `clearCaptureSuppressed('ses_x')` it is false and the flag is false on the row.
- `markDeliverySent`, `markDeliveryRetried` set `delivery_state` 1 and 2; `unconfirmedPeerDeliveries()` returns only peer rows (`sender` not `human`/`boss`) with `delivery_state = 0`.
- Rows inserted without the new fields keep `message_id NULL`, `capture_suppressed 0`, `delivery_state 1` (legacy rows are considered delivered - they predate the mechanism).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/test/chat-store.test.ts`
Expected: FAIL - methods do not exist / column missing.

- [ ] **Step 3: Add the columns and migration**

In `schema.ts` `messages`: `messageId: text('message_id')`, `captureSuppressed: integer('capture_suppressed', { mode: 'boolean' }).notNull().default(false)`, `deliveryState: integer('delivery_state').notNull().default(1)`, plus `uniqueIndex('idx_msg_message_id').on(table.messageId)`.

Migration content (`0005_peer_messaging.sql`):

```sql
ALTER TABLE `messages` ADD `message_id` text;
ALTER TABLE `messages` ADD `capture_suppressed` integer DEFAULT false NOT NULL;
ALTER TABLE `messages` ADD `delivery_state` integer DEFAULT 1 NOT NULL;
CREATE UNIQUE INDEX `idx_msg_message_id` ON `messages` (`message_id`);
```

Register it in `meta/_journal.json` with the same tag and a fresh timestamp, and add `meta/0005_snapshot.json` (copy `0004_snapshot.json`, add the three columns and the index). Startup `runMigrations` applies it; verify an existing db upgrades by running the server once against a copy of `.data/messages.db`.

- [ ] **Step 4: Implement the repository methods**

Insert statement gains the three columns; `findByMessageId` uses the unique index; `isCaptureSuppressed` is `SELECT 1 FROM messages WHERE session_id = ? AND capture_suppressed = 1 LIMIT 1`; `clearCaptureSuppressed` is `UPDATE messages SET capture_suppressed = 0 WHERE session_id = ? AND capture_suppressed = 1`; `markDeliverySent`/`markDeliveryRetried` set 1 and 2; `unconfirmedPeerDeliveries` selects `delivery_state = 0 AND sender NOT IN ('human','boss')` ordered by id.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/test/chat-store.test.ts server/test/chat-dedup.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/infrastructure/database server/src/modules/chat/domain/message.ts server/src/modules/chat/application/ports.ts server/src/modules/chat/infrastructure/message-repository.ts server/test/chat-store.test.ts
git commit -m "feat (v1): message idempotency key, capture suppression, delivery state"
```

---

### Task 3: Allowlist policy and local bootstrap files

**Files:**
- Create: `server/src/modules/chat/infrastructure/peer-allowlist.ts`
- Create: `config/peer-to-peer-allowlist.example.json`
- Modify: `.gitignore`
- Modify: `setup.mjs` (copy the example to `config/peer-to-peer-allowlist.json` when absent)
- Test: `server/test/peer-allowlist.test.ts`

**Interfaces:**
- Produces:
  - `type PeerAllowlist = Readonly<Record<string, readonly string[]>>`
  - `readPeerAllowlist(filePath?: string): Promise<PeerAllowlist>` - throws `AppError(500, 'allowlist_invalid', ...)` when the file is present but malformed; resolves an empty object when absent.
  - `isPairAllowed(allowlist: PeerAllowlist, from: string, to: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
it('allows exactly the listed pairs', async () => {
  const file = writeTempJson({ human: ['boss'], boss: ['human'], ruben: ['boss', 'human'] });
  const acl = await readPeerAllowlist(file);
  expect(isPairAllowed(acl, 'ruben', 'boss')).toBe(true);
  expect(isPairAllowed(acl, 'ruben', 'greg')).toBe(false);
});

it('absent file yields an empty allowlist (no peer sends)', async () => {
  expect(await readPeerAllowlist('/nonexistent/allowlist.json')).toEqual({});
});

it('malformed file throws a loud AppError', async () => {
  const file = writeTempText('{ "human": "boss" }');
  await expect(readPeerAllowlist(file)).rejects.toMatchObject({ statusCode: 500, code: 'allowlist_invalid' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/peer-allowlist.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement the loader and matcher**

Zod schema: `z.record(z.string().min(1), z.array(z.string().min(1)))`. Read per call (fresh, like `agents.json`); an absent file returns `{}`; a malformed file throws the loud `AppError`. `isPairAllowed` is `allowlist[from]?.includes(to) ?? false`.

- [ ] **Step 4: Add the example file, gitignore, and setup copy**

`config/peer-to-peer-allowlist.example.json`:

```json
{
  "human": ["boss", "coordinator"],
  "boss": ["human", "coordinator"],
  "coordinator": ["human", "boss"]
}
```

`.gitignore`: add `config/peer-to-peer-allowlist.json` (the real file only). `setup.mjs`: after the registry step, copy the example to the real path when absent and log `DONE created config/peer-to-peer-allowlist.json - edit the pairs`.

- [ ] **Step 5: Run tests and the setup check**

Run: `npx vitest run server/test/peer-allowlist.test.ts` then `node setup.mjs`
Expected: tests PASS; setup reports the existing-install checks (it must not overwrite existing files).

- [ ] **Step 6: Commit**

```bash
git add config/peer-to-peer-allowlist.example.json .gitignore setup.mjs server/src/modules/chat/infrastructure/peer-allowlist.ts server/test/peer-allowlist.test.ts
git commit -m "feat (v1): peer-to-peer allowlist policy + local bootstrap"
```

---

### Task 4: Principal resolution from bearer tokens

**Files:**
- Create: `server/src/api/middleware/peer-auth.ts`
- Modify: `server/src/infrastructure/config/index.ts` (read `.data/peer-auth.json`)
- Modify: `server/src/app.ts` (wire the middleware + identity route)
- Test: `server/test/peer-auth.test.ts`

**Interfaces:**
- Produces:
  - `interface Principal { readonly name: string; readonly kind: 'human' | 'boss' | 'agent' }`
  - `AppConfig.peerAuth?: ReadonlyMap<string, Principal>`
  - `resolvePrincipal(principals: ReadonlyMap<string, Principal> | undefined)` - a Fastify preHandler that sets `request.principal` when a token matches; no principals configured means no hook (legacy open mode).
  - `GET /api/principal` -> `{ name, kind }` for the presented token, `401` otherwise (registered only when principals exist).

- [ ] **Step 1: Write the failing tests**

- A request with a valid `Authorization: Bearer <talk>` sets `request.principal` to `{ name: 'ruben', kind: 'agent' }`.
- Wrong or missing token -> `401` with the existing `unauthorized` envelope and `www-authenticate` header.
- `GET /api/principal` returns the mapped name for a valid token; 404 when no principal file is configured.
- Config: `.data/peer-auth.json` shape `{ "tokens": { "<token>": { "name": "ruben", "kind": "agent" } } }`; malformed JSON or a bad `kind` fails startup with a clear message (same style as `.data/server.auth.json`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/peer-auth.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement config reading and the middleware**

Add `DEFAULT_PEER_AUTH_FILE = '.data/peer-auth.json'`. Zod: `z.object({ tokens: z.record(z.string().min(1), z.object({ name: z.string().min(1), kind: z.enum(['human', 'boss', 'agent']) })) })`. Absent file -> `peerAuth` undefined. Present but empty/malformed -> throw (fail loud, same rationale as the auth file). Middleware compares with a constant-time compare (`timingSafeEqual` on equal-length buffers) and throws the existing `AppError(401, 'unauthorized', 'Missing or invalid bearer token')`.

- [ ] **Step 4: Wire in `app.ts`**

Register `GET /api/principal` on the chat routes when `config.peerAuth !== undefined`; pass `principals` to `chatRoutes` alongside the existing `authToken` (leave the legacy shared-token path untouched for now; Task 5/7 replace its use for `/send`).

Add the log redaction the spec requires: in `server/src/server.ts`, the Fastify logger must redact `req.headers.authorization` (pino `redact: ['req.headers.authorization']`), and a test in `server/test/peer-auth.test.ts` asserts a logged request does not contain the token string.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/test/peer-auth.test.ts server/test/chat-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/api/middleware/peer-auth.ts server/src/infrastructure/config/index.ts server/src/app.ts server/test/peer-auth.test.ts
git commit -m "feat (v1): bearer-token principal resolution"
```

---

### Task 5: Peer send path in the chat service

**Files:**
- Modify: `server/src/modules/chat/application/chat-service.ts:339-395`
- Modify: `server/src/modules/chat/application/ports.ts` (`ChatDeps` gains `allowlist` reader)
- Modify: `server/src/app.ts` (inject `readPeerAllowlist`)
- Test: `server/test/chat-send.test.ts`

**Interfaces:**
- Consumes: `Principal` (Task 4), `parsePromptSender`/`composePrompt` (Task 1), allowlist (Task 3), store methods (Task 2).
- Produces:
  - `SendInput` gains `readonly authenticated?: boolean` and `readonly messageId?: string`.
  - `SendMessageResult = { sent: string[]; skipped: string[]; messageId: string | null }` (existing callers keep `sent`/`skipped`).

- [ ] **Step 1: Write the failing tests**

In `server/test/chat-send.test.ts`, with a fixture constructed from `peerAuth` + a temp allowlist file:
- agent principal `ruben` sends to `boss` (allowed) -> prompt call `Peer ruben: hi`, one row `from ruben to boss`, `delivery_state` 1 after success.
- `ruben` -> `greg` not in the allowlist -> `403 forbidden_pair`, no prompt, no row.
- `ruben` -> `all` -> `403 forbidden_pair`.
- `ruben` -> `['boss','human']` -> `403 forbidden_pair` (single recipient only for peers).
- `ruben` -> `human` (allowed) -> row saved, zero prompt calls.
- body `from: 'boss'` with ruben's token -> `403 identity_mismatch`.
- body starting `Human: ` -> `400 reserved_prefix`.
- agent -> unknown agent name (allowed pair, missing registry entry) -> `404 no_targets`, nothing archived.
- retry with the same `messageId` -> second call returns the same `sent` and the store holds one row.
- legacy mode (no principals configured): `from: 'human'` and default `boss` behave exactly as today (existing tests must stay green).
- prompt failure for a peer target -> row kept, `delivery_state` 0, recipient listed in `skipped`.
- human/boss `to: 'all'` where the allowlist omits one resolved agent -> `403 forbidden_pair` naming the agent; nothing archived or prompted.
- missing allowlist file with a peer principal -> `403 forbidden_pair`; a `human` principal still sends normally.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/chat-send.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the send path**

Rules to implement, in this order: validate `text`; resolve `sender` (`authenticated` -> `input.from` required, else body `from ?? 'boss'` and the legacy `human|boss` check); in authenticated mode reject reserved-prefix bodies and a body `from` that differs from the principal; resolve targets (peers: exactly one, `all` rejected; human/boss: existing all/name/array); for peers load the allowlist and reject unlisted pairs; when the sender is an agent require `messageId` matching `^msg_[A-Za-z0-9_-]+$`; insert the row BEFORE prompting (peer rows: `sessionId` = sender's registry session, `captureSuppressed: true`, `deliveryState: 0`; human/boss rows keep today's `sessionId: null` and no idempotency requirement); then prompt (`composePrompt`) and mark the row's delivery state. On duplicate `messageId` return `findByMessageId`'s targets with no new prompt. Keep the existing `{sent, skipped}` semantics and the `to` join for multi-target human/boss sends.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/test/chat-send.test.ts server/test/chat-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/chat/application/chat-service.ts server/src/modules/chat/application/ports.ts server/src/app.ts server/test/chat-send.test.ts
git commit -m "feat (v1): authenticated peer /send with allowlist and single-row archive"
```

---

### Task 6: Observed-inbound attribution, capture suppression, and wake gating

**Files:**
- Modify: `server/src/modules/chat/application/chat-service.ts:135-185`
- Test: `server/test/chat-routing.test.ts`

**Interfaces:**
- Consumes: `parsePromptSender` (Task 1), `isCaptureSuppressed`/`clearCaptureSuppressed` (Task 2).
- Produces: no new public API; `handleEvent` gains the inbox handling for non-Boss sessions.

- [ ] **Step 1: Write the failing tests** in `server/test/chat-routing.test.ts`

- inbox event for `ruben` with body `Peer boss: go` -> the next `ruben` reply is saved `to: boss` (derived from the observed prefix, not from the last `/send`).
- two queued `/send` prompts to `ruben` (`boss` then `greg`); only after greg's inbox item is observed does ruben's reply route to `greg`.
- reply with no observed inbound after the slot was consumed -> `to: boss` (fallback).
- reply from a session with an armed row -> NOT saved as a second message.
- inbox item for a session with an armed row -> armed rows cleared before the reply is archived.
- peer -> peer reply -> `wakeBoss` not called; agent -> boss reply -> `wakeBoss` called.
- Human/Boss behavior unchanged: Boss reply still saved `to: human`; human inbox to boss still saved.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/chat-routing.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

In the inbox branch: always `clearCaptureSuppressed(to)`; when `to` is Boss keep the existing echo filter and save; otherwise parse the prefix, and when it yields a sender, record a pending sender for that session (single-use map `#pendingReplyTo: Map<sessionId, name>`), replacing the send-time `#lastPromptFrom` recording on the peer path. In the reply branch: if `isCaptureSuppressed(sessionId)` skip the save entirely (transcript, not a message); else route to the pending sender if present and consume it, otherwise Boss. Wake only when the routed recipient is `boss` or `human`; a peer recipient skips `wakeBoss`. Delete the old send-time `#lastPromptFrom.set` for peer sends; keep it for human/boss sends so their behavior is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/test/chat-routing.test.ts server/test/chat-wake.test.ts server/test/chat-wake-race.test.ts`
Expected: PASS (update wake tests only where the peer rule changed the expectation).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/chat/application/chat-service.ts server/test/chat-routing.test.ts server/test/chat-wake.test.ts server/test/chat-wake-race.test.ts
git commit -m "feat (v1): observed-inbound reply attribution + peer wake suppression"
```

---

### Task 7: Routes, startup reconciliation, and legacy-token retirement

**Files:**
- Modify: `server/src/modules/chat/presentation/routes.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/chat-routes.test.ts`

**Interfaces:**
- Consumes: `resolvePrincipal` (Task 4), `SendInput.authenticated`, `unconfirmedPeerDeliveries` (Task 2).
- Produces: `ChatService.reconcileDeliveries(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

- With `peerAuth` configured: `/send` without a token -> 401; with ruben's token and `to: greg` -> 403; with ruben's token and `to: boss` -> 200.
- With `peerAuth` absent: `/send` behaves exactly as before (no token needed, `from` body rules).
- `reconcileDeliveries` re-prompts each unconfirmed peer row once, marks it retried, and does not touch rows already sent or human/boss rows.
- A second `reconcileDeliveries` call in the same process prompts nothing.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/chat-routes.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

Routes: when principals exist, `POST /send` requires the principal preHandler and passes `authenticated: true, from: principal.name`; `POST /prompt` requires a principal of kind `human` (webchat) and keeps the existing shared-token path when no principals exist. Presentation stays thin: no allowlist or prefix logic here. Service: add `reconcileDeliveries()` - read `unconfirmedPeerDeliveries()`, resolve each row's recipient session from the registry, prompt once with the recomposed prefix, then `markDeliverySent` or `markDeliveryRetried`; log a single line with counts. In `app.ts`, call `void chat.reconcileDeliveries()` after wiring (log failures, never throw at startup).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/test/chat-routes.test.ts server/test/sse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/chat/presentation/routes.ts server/src/app.ts server/test/chat-routes.test.ts
git commit -m "feat (v1): principal-gated send routes + startup delivery reconciliation"
```

---

### Task 8: Human token in the dashboard

**Files:**
- Modify: `web/src/lib/api.ts` (token storage + `Authorization` header + `fetchPrincipal`)
- Modify: `web/src/components/TopNav.tsx` (Connect/Disconnect in the Settings menu)
- Modify: `web/src/App.tsx` (pass connection state down if needed)
- Test: `web/test/api-client.test.ts`

**Interfaces:**
- Produces:
  - `getHumanToken(): string | null` (reads `sessionStorage['lobby.humanToken']`)
  - `setHumanToken(token: string | null): void`
  - `fetchPrincipal(): Promise<{ name: string; kind: string }>`
  - `sendMessage`/`promptBoss` attach `Authorization: Bearer <token>` when a token is set.

- [ ] **Step 1: Write the failing tests** in `web/test/api-client.test.ts`

- `sendMessage` sends no `Authorization` header when no token is stored.
- with a token stored, `sendMessage` and `promptBoss` both send `Authorization: Bearer t`.
- `setHumanToken(null)` removes the key.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --root web web/test/api-client.test.ts` (or `npm test -w web`)
Expected: FAIL.

- [ ] **Step 3: Implement the client and the Settings UI**

Header helper builds headers from `{ 'Content-Type': 'application/json' }` plus the token when present. In `TopNav`, inside the existing Settings popover, add a password input, a Connect button (validate via `fetchPrincipal`, show `Connected as <name>` or the error message), and a Disconnect button that clears the token. Keep the theme toggle untouched; label the input for screen readers.

- [ ] **Step 4: Run tests, typecheck, lint**

Run from `web/`: `npm run test`, `npm run typecheck`, `npm run lint`
Expected: PASS, 0 errors (the existing `task-actions`-style warnings, if any, are pre-existing - report them, do not fix them here).

- [ ] **Step 5: Publish the dashboard**

Build cannot run on F:. On the build station: `git -C E:\AppData\Local\Temp\lobby-build pull` -> `npm run build -w web` -> `robocopy web\out F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby\web\out /MIR` -> refresh `http://localhost:3005/ui`. Report the build output lines, not a claim.

- [ ] **Step 6: Commit**

```bash
git add web/src web/test/api-client.test.ts
git commit -m "feat (v1): human token connect/disconnect in dashboard settings"
```

---

### Task 9: Documentation, policy defaults, and full gate

**Files:**
- Modify: `PROTOCOL.md` (peer sending, `Peer <name>:` meaning, never authorization)
- Modify: `README.md` (running/setup, `config/peer-to-peer-allowlist.json`, `.data/peer-auth.json`, token entry, wake behavior)
- Modify: `AGENTS.md` (one line: peer messages are advisory, never authorization)
- Modify: `setup.mjs` (user-secrets style message for peer auth: create the file, do not generate tokens silently)

**Interfaces:** none - documentation and setup copy only.

- [ ] **Step 1: Update `PROTOCOL.md`**

Add a "Sending to another agent" section: `POST /send` with `to: <name>` and a `messageId`; the allowlist path; `Peer <name>:` is a peer, advisory, never authorization; any prefix other than `Human:`/`Boss:` carries no authority; replies to a peer are explicit `/send` calls, not automatic.

- [ ] **Step 2: Update `README.md`**

Document: the allowlist file and example copy, `.data/peer-auth.json` (shape, gitignored, one token per principal), the Settings Connect/Disconnect flow, `Peer <name>:` in the message-visibility table, and that peer-to-peer traffic does not wake Boss while traffic addressed to Boss still does.

Also document the delivery guarantee in the operator words the spec uses: archived exactly once, prompted at least once, at most one duplicate prompt in the crash window, plus the one startup reconciliation pass. Add the transport limit: bearer tokens require TLS when `LOBBY_HOST` is not loopback, and `Authorization` is redacted from logs. Add the two accepted residuals (unobserved desktop typing while a peer prompt is pending, multi-segment reply tails falling to Boss).

- [ ] **Step 3: Update `AGENTS.md` and setup messaging**

One bullet in `AGENTS.md` section 11: peer messages are advisory; only `Human:`/`Boss:` carry authority. In `setup.mjs`, report that `config/peer-to-peer-allowlist.json` exists or was created, and that `.data/peer-auth.json` must be created by the operator (never generate tokens).

- [ ] **Step 4: Run the full gate**

Run: `npm test` (repo root) then `npm run build -w server`
Expected: all suites green; build exit 0. Record the actual counts.

- [ ] **Step 5: Commit**

```bash
git add PROTOCOL.md README.md AGENTS.md setup.mjs
git commit -m "docs (v1): peer messaging protocol, allowlist, and dashboard token flow"
```
