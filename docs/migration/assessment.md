# Agents-Lobby Migration — Phase 1 Assessment

**Date:** 2026-11-17 · **Method:** read-only source inspection of the canonical worktree (`F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby`). Every current-behavior claim cites file:line. Unverified runtime artifacts (`.data/messages.db`, real `agents.json`) were **not** opened, per work order.

---

## 0. Correction to the work order (verified)

- **Schema column names.** MIGRATION.md §2 says `messages(id, ts, from, to, body, session_id)`. The real schema is `messages(id, ts, sender, receiver, body, session_id)` — `from`/`to`/`text` are **wire aliases only** (`store.mjs:7-17`). The §5 "from is a SQL keyword" concern is moot in the baseline: use the real column names (`sender`, `receiver`, `body`) so Drizzle can open a copy of the canonical db byte-identically. Any rename stays additive/never (see §5).
- **Route inventory is larger than §2 lists.** The bridge also serves `GET /api/last-activity`, `GET /api/stream` (SSE), `GET /api/local-projects` (`bridge.mjs:288-340`), and the current dashboard consumes all three (`src/data/api.ts:56-74`). Decision 2's compat list omits them — flagged in §7.
- **Test count.** 7 tests across `test/store.test.mjs` (5) + `test/local-projects.test.mjs` (2) — matches §2. There is **no `test` script in `package.json`** (`package.json:6-9`); tests run via `node --test test/*.test.mjs` directly.

---

## 1. Dependency map (as implemented)

```
OpenCode server (local, port discovered at startup)
   ▲ prompt POST /api/session/{id}/prompt        │ GET /api/event (SSE, manual parse)
   │ GET  /api/session/{id}/inbox                ▼
bridge.mjs ── openStore() ──► store.mjs ──► .data/messages.db (node:sqlite)
   ▲ re-reads agents.json per request/event-line (lastPromptFrom Map in memory)
   │ HTTP :3005
   ├── GET  /ui, /ui/*      → dist/ static (React build)
   ├── GET  /api/agents     → registry read
   ├── GET  /api/messages   → store.query
   ├── GET  /api/last-activity → store.lastActivity
   ├── GET  /api/stream     → store.onInsert → SSE push (25s heartbeat)
   ├── GET  /api/local-projects → local-projects.mjs (readdir ./projects)
   ├── POST /webhook        → store.insert + wakeBoss
   ├── POST /prompt         → prompt(boss session)  (logging via listener)
   └── POST /send           → fan-out prompt() + store.insert
```

Data flows, verified:

- **Startup** (`bridge.mjs:10-38`): reads `agents.json` (exit 1 on failure); discovers the OpenCode server URL via `spawnSync("opencode", ["service", "status"])` with fallback `config.serverUrl` (`bridge.mjs:22-34`) — the local port changes on restart, so discovery at startup is required. Opens the store (default `./.data/messages.db`, `store.mjs:22`).
- **OpenCode auth** (`bridge.mjs:57-73`): HTTP Basic from the password in `~/.config/opencode/service.json` (outside the repo); attached to every upstream call (`bridge.mjs:75-84`).
- **Event listener → store** (`bridge.mjs:137-212`): one fetch to `GET /api/event`, manual `data:` line parsing, reconnects 5 s after drop (volatile — no replay, `bridge.mjs:133-135`). Per event line it re-reads the registry and resolves the session: boss session, or agent by session id; unknown sessions are skipped (`bridge.mjs:160-165`).
  - `session.inbox.enqueued` — **boss session only**, `item.type === "user"`, and the text is neither exactly `"[message received]"` nor starts with `"[message received]\n\n"` → save `human → boss` (`bridge.mjs:166-185`). This echo filter is what keeps the bridge's own wake prompt and `/send`-logged synthetic echoes out of the store; a real message merely *beginning* with the wake text still captures.
  - `session.text.ended` with text — boss session → save `boss → human`; agent session → save `agentName → lastPromptFrom.get(name) || "boss"`, then `wakeBoss()` (`bridge.mjs:186-204`).
- **Fan-out send** (`POST /send`, `bridge.mjs:390-443`): body `{to, message, from = "boss"}`; `from` restricted to `human|boss` (400 otherwise). `to === "all"` → all registry agents; otherwise name match or array membership. No match → 404. Prefix `Human:`/`Boss:`; per target `lastPromptFrom.set(name, sender)` **before** awaiting the prompt; `Promise.allSettled` → `sent` / `skipped` lists; the row saved is `{from: sender, to: sent.join(", "), body: text}` (successful targets only — the saved `to` is the *sent* list, not the request's `to`).
- **Wake slice** (`wakeBoss`, `bridge.mjs:98-130`): skip if `GET /api/session/{boss}/inbox` already has a pending `user` item (coalescing, zero tokens). Unread slice = `store.unread("boss")` minus `from === "boss"` rows and `from === "human" && to === "boss"` rows (already natively in the boss session). Text = `"[message received]"` + `[time] [from: X] [to: Y] text` lines, or the bare wake prompt if the slice is empty. The bookmark advances only **through the slice** (`markSeen("boss", rows[last].id)`); an empty slice moves no bookmark.
- **Webchat** (`POST /prompt`, `bridge.mjs:365-388`): `{message}` → prompt the boss session with `delivery: "queue"`; the message is logged **only** by the event listener (inbox.enqueued capture), not by the route.
- **Webhook (legacy)** (`POST /webhook`, `bridge.mjs:342-363`): `{from, message}`; `from` defaults `"unknown"`, `to: null`, `sessionId: null`; then `wakeBoss()`. Protocol v2: agents no longer webhook — their replies capture from the session event stream (`bridge.mjs:136`).
- **Store** (`store.mjs`): insert notifies all SSE subscribers with the full wire row `{id, time, from, to, text}` (`store.mjs:41-51`). Query views: `all` | `boss` (sender/receiver = boss) | `agent:<name>` (member clause: sender, `receiver='all'`, exact receiver, or comma-list containing the name) | `project:<name>` (OR over the project's agents — the bridge resolves agent names from the registry first, `bridge.mjs:276-282`). Pagination: `before > 0` → id `< before`, DESC; else `after > 0` → id `> after`, ASC; fetches `limit + 1` → `hasMore`; results reversed to ascending for the initial/before direction (`store.mjs:53-92`). Assumption, not an invariant: **id order == ts order** — the source only assigns ts at insert, so ties or clock changes could break the ordering; verify against the db copy during Phase 4 before relying on it (`store.mjs:112-114`). `lastActivity` returns per-view latest ts via top-1 index scans (`store.mjs:116-134`).
- **Frontend** (`src/`, built to `dist/`, served at `/ui` with per-asset cache headers, `bridge.mjs:220-253`): `src/data/api.ts` owns all fetch/SSE calls and view-model helpers (`View`, `viewParam`, `isVisible`, `defaultTargets`, `projectGroups`); `src/hooks/useMessages.ts` implements per-view caches with SSE append + `after=<newestId>` catch-up drain (invariants I1/M2/F2-F5 documented in-file), `loadOlder` via `before=<oldestId>`; components: `TopNav`, `Sidebar`, `ProjectsSidebar`, `ChatFeed`, `MessageBubble`, `Composer` (`src/components/TopNav.tsx`, `src/components/Sidebar.tsx`, `src/components/ProjectsSidebar.tsx`, `src/components/ChatFeed.tsx`, `src/components/MessageBubble.tsx`, `src/components/Composer.tsx`); `useTheme` for dark/light (`src/hooks/useTheme.ts`). Vite `base: '/ui/'`, dev proxy `/api` + `/send` → :3005 (`vite.config.ts:6-13` — note `/prompt` and `/webhook` are **not** proxied in dev).
- **Registry** (`agents.json`, gitignored; example `agents.example.json:1-8`): `{serverUrl, boss: {name, project, session}, agents: [{name, project, session}]}`. Re-read per request and per event line — new agents usable without a bridge restart (`bridge.mjs:47-49, 161-163`).
- **`local-projects.mjs`** (pure module, no side effects): readdir, ENOENT → `[]`, filters dot-entries/files (`local-projects.mjs:9-20`); the route catches everything else as a controlled 500 (`bridge.mjs:331-339`).
- **Entry guard** (`bridge.mjs:448-464`): the server binds :3005 only when bridge.mjs is the process entry — imports (tests) never bind.

**Unverified runtime artifacts:** `.data/messages.db` (real data, schema asserted from `store.mjs:7-15` + migration history comments), real `agents.json`, `~/.config/opencode/service.json`, and the OpenCode server's actual `/api/event` payload envelope (inferred from the parsing at `bridge.mjs:146-166`; event types verified as consumed: `session.inbox.enqueued`, `session.text.ended`).

---

## 2. Risk list (ranked — what can break during strangler migration)

1. **Wake-prompt echo filter, exact-match semantics.** The listener distinguishes the bridge's own wake prompt by *exact* equality and the `WAKE_PROMPT + "\n\n"` prefix (`bridge.mjs:172-178`). The new stack must reuse the identical constant `"[message received]"` and identical comparison, or genuine human input resembling the wake prompt is dropped / the wake slice is re-captured as human input (duplicate rows). The wake prompt text is also load-bearing on the boss side (AGENTS.md wake trigger, `bridge.mjs:94`) — same string, no paraphrasing.
2. **Boss wake slice + bookmark race.** Slice filter (exclude boss's own rows, exclude human→boss), bookmark advances only through the slice, rows inserted during the enqueue `await` stay unread, empty slice → no bookmark move (`bridge.mjs:111-124`; `store.mjs:101-108`). A naive rewrite that calls `markSeen()` after enqueueing swallows the gap rows. Also: coalescing depends on reading the boss inbox *before* prompting (`bridge.mjs:102-106`).
3. **`lastPromptFrom` map.** In-memory only; lost on restart (reply target falls back to `"boss"`, `bridge.mjs:53, 195`). New stack may persist it, but must at minimum reproduce the fallback; also note it is set *before* the prompt await (`bridge.mjs:416`) — order matters for a reply racing the send.
4. **Fan-out save semantics.** Saved `to` = comma-joined *successful* targets, `skipped` reported separately, 400 on non-`human|boss` sender, 404 on no targets (`bridge.mjs:394-443`). Tests and the dashboard consume `{sent, skipped}`. Partial failures must keep partial-succeeds semantics.
5. **Pagination/`hasMore` contract.** `limit+1` fetch, direction-dependent ordering and reversal, `before` wins over `after`, negative-limit clamp at the route (`bridge.mjs:272-275`; `store.mjs:53-92`). The frontend drain loop (I1/M2) assumes exact `hasMore` behavior (`useMessages.ts:222-271`). Any deviation breaks catch-up and infinite-scroll.
6. **SSE recovery.** Today's `/api/stream` pushes raw rows with **no** `Last-Event-ID`; the frontend does `after=<newestId>` catch-up on every stream open (`api.ts:52-66`; `useMessages.ts:191-277`). Hazard for the new stream: `Last-Event-ID` is **one cursor for the whole stream**, so message ids and activity-event ids must not be separate sequences — with two sequences, a status event with id 100 can permanently skip a later message with id 50 (`id > lastEventId` never matches it). Ruling adopted (Boss): a **single persisted `events` table with one shared monotonic sequence** is the only `Last-Event-ID` cursor; all event types replay from it (§7). Message content ordering rests on the id==ts-order **assumption** (§1 Store) — not a guaranteed invariant; it is to be verified against the db copy during Phase 4.
7. **Registry re-read semantics.** Bridge re-reads `agents.json` per request/event line; decision 3 says startup mirror + sync. If the mirror syncs only at startup, newly added agents won't serve until restart — a visible regression. Resolve: file-watch or re-read-on-request inside the agents module.
8. **Routes omitted from decision 2.** `/api/stream`, `/api/last-activity`, `/api/local-projects` are used by the current dashboard (`api.ts:56-74`) but not in the compat list. `/api/stream` is superseded by `/api/events` (Phase 6 rebuilds the consumer); `/api/last-activity` and `/api/local-projects` still need a home in the new stack — recommend reimplementing both (§7). Needs Boss sign-off as a minor deviation.
9. **OpenCode server URL discovery.** Port changes on restart; discovery via `opencode service status` at startup with `serverUrl` fallback (`bridge.mjs:22-34`). New adapter needs the same discovery + config fallback + auth-header handling, or the whole integration silently no-ops.
10. **`receiver` NULL and list forms.** `/webhook` rows have `to: null`; member views rely on the comma-list membership clause with space normalization (`store.mjs:20`; `api.ts:104-116` handles null). The new schema/query must reproduce all four membership forms exactly.
11. **Duplicate-capture edge.** A real human message beginning with `"[message received]\n\n"` still captures by design (`bridge.mjs:172` comment); a rewrite using `includes()` instead of `startsWith` on the exact two forms would change that.
12. **Baseline fidelity.** Migration runs against a *copy*; anything byte-different from `store.mjs:7-15` (column names, types, nullability, defaults, indexes) risks failing to open or corrupting copied data. (Mitigated: §5.)

---

## 3. Target structure (adapted §3 — only what Phases 2–6 will actually create)

```
server/
  src/
    modules/
      chat/
        domain/            # Message, views, membership rules, wake-slice builder (pure)
        application/       # query views, ingest (webhook/send/prompt-capture), fan-out, wake orchestration
        infrastructure/    # chat repository (drizzle), bookmarks repo
        presentation/      # nothing initially — routes live in api/ until volume justifies (see note)
      projects/
        domain/            # Project, membership of agents
        application/       # registry-mirror read, local-projects listing orchestration
        infrastructure/    # filesystem lister (port of local-projects.mjs)
      agents/
        domain/            # Agent, boss/agent registry types
        application/       # agents.json mirror load/sync, lookup by name/session/project
        infrastructure/    # registry file reader (per-request re-read semantics, §2 risk 7)
      activity/
        application/       # last-activity stamps (reads chat repository), event emission
    integrations/
      opencode/
        client.ts          # base URL discovery, basic auth, fetch with timeouts
        events.ts          # /api/event SSE subscribe + reconnect + parse + normalize (all OpenCode interpretation)
        sessions.ts        # inbox read (wake coalescing) — protocol-neutral boolean out, wire shapes internal
        prompts.ts         # prompt(session, text) — queue delivery is an adapter-internal decision
    infrastructure/
      database/{schema.ts,migrations/,client.ts}
      events/              # in-process event bus + SSE fan-out + Last-Event-ID persistence
      config/              # port 3006, paths, body limit, optional secret file, zod-validated env
    api/
      routes/              # thin Fastify handlers (delegate to application) — routes centralized here, matching "no business logic in handlers"
      middleware/          # auth plugin (bearer secret), error mapping
      plugins/
    shared/
      {types,schemas,errors}/
  test/                    # vitest (unit + integration against db copy fixture)
web/                       # Next.js App Router + shadcn/ui (Phase 6)
docs/migration/            # this assessment
```

Note (deviation, small): the §3 layout shows `presentation/` per module; handlers are thin enough that a centralized `api/routes/` is the honest structure — module `presentation/` folders are created only when a module's route set justifies it (chat first, Phase 4). No empty speculative layers.

---

## 4. Module boundaries

| Concern | Moves to | Stays in `integrations/opencode` | Infrastructure owns |
|---|---|---|---|
| Message rows, views (all/boss/agent:/project:), pagination, membership clause, bookmarks/unread, wake-slice filtering | **chat** (domain: pure rules incl. member clause + wake slice filter; application: query/ingest/fan-out/wake orchestration) | — | drizzle schema + repos |
| Fan-out targets, lastPromptFrom map, sent/skipped accounting | **chat** application (uses agents module for target lookup) | prompt delivery mechanics (`delivery: "queue"`, adapter-internal — `bridge.mjs:86-92`) | — |
| Wake orchestration (inbox coalescing check, wake text assembly) | **chat** application (slice text assembly; consumes the adapter's protocol-neutral `hasPendingUserInput(sessionId)` boolean — no inbox wire shapes cross the boundary) | inbox fetch + `type === "user"` interpretation (`hasPendingUserInput`), `prompt(...)` calls, event subscription | — |
| Protocol v2 event interpretation (`inbox.enqueued` semantics, `text.ended` reply capture, `[from/to]` marker parsing) | **ALL interpretation lives in `integrations/opencode`** — it emits protocol-neutral normalized items `{kind, from, to, body, sessionId, ts}` (no OpenCode markers downstream). **chat** applies capture policy in domain terms only: boss-only filter compares the normalized `to` against the boss name from its registry state; echo detection compares `body` against the wake text chat itself enqueued; reply routing uses its last-prompt record (§6) | SSE connect/reconnect/parse, event normalization, wake-marker format + constant | — |
| Registry (`agents.json`) mirror, boss/agent lookup, project grouping | **agents**, **projects** (registry read) | — | file reader |
| Local projects listing | **projects** | — | filesystem access |
| Last-activity stamps, event bus emission (`message.created` etc.) | **activity** application | — | event bus + SSE |
| HTTP concerns: routing, validation (zod), auth plugin, body limits, SSE endpoint, error mapping | — | — | **api/** |
| Config, db client, migrations | — | — | **infrastructure/** |

Rule check: "no OpenCode-specific logic outside `integrations/opencode`" (`MIGRATION.md:157`) now holds by construction — the adapter emits protocol-neutral normalized items only, so chat/application code never tests OpenCode event types or inbox-item markers; the prompt port takes only a session id and text — delivery mechanics stay inside the adapter (§6); its filters compare domain names (boss/agent from its registry state) and its own outbox (the wake text it sent). Domain modules import neither Fastify nor drizzle (repositories defined as interfaces in domain/application, implemented in infrastructure).

---

## 5. DB migration strategy

- **Baseline (byte-fidelity, verified `store.mjs:7-15`):**

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  sender TEXT NOT NULL, receiver TEXT, body TEXT NOT NULL, session_id TEXT);
CREATE TABLE bookmarks (
  consumer TEXT PRIMARY KEY, last_seen_id INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_msg_receiver ON messages(receiver, id);
CREATE INDEX idx_msg_sender ON messages(sender, id);
```

  Column names are `sender`/`receiver`/`body` (NOT `from`/`to` — see §0). The `from`-keyword concern from the work order applies only if a future rename to `from` is attempted; **do not rename in the baseline** — the wire alias (`ts AS time, sender AS "from", receiver AS "to", body AS text`, `store.mjs:17`) stays a repository-level mapping. `receiver` and `session_id` are nullable (no NOT NULL in the schema; `/webhook` writes `receiver = NULL`).
- **Process:** copy `.data/messages.db` (file-level copy only — the canonical db is never opened by us; the copy is made available by the Boss/coordinator into the dev worktree, decision 6). Baseline drizzle migration is marked as applied (drizzle-kit baseline/introspection flow) so migrations 0002+ evolve from there. Verify against the copy: row counts per table before/after, `SELECT MAX(id)` unchanged, wire-shape spot checks (a few ids mapped through the alias), and the id==ts-order assumption (§1) on the copy.
- **Additive evolution rules:** new columns only nullable or with defaults; new tables only for an existing use case (agents/projects mirror per decision 3; the `events` table for the shared SSE cursor — adopted ruling, §7); new indexes; never drop/rename/retype existing columns; FKs only where a current use case exists.
- **Existing store tests keep passing at repo root** (work order §6) — `test/*.test.mjs` stays untouched in the dev worktree.

---

## 6. OpenCode adapter contract (Phase 3 implements these in `server/src/integrations/opencode/`)

```ts
// client.ts
export interface OpenCodeClientConfig {
  /** Optional fallback value from agents.json serverUrl (bridge.mjs:22-34).
   *  The caller (composition root) may supply this CONFIGURED value — it is
   *  plain config passed through, not protocol knowledge. Discovery of the
   *  EFFECTIVE server URL via `opencode service status` happens INSIDE the
   *  adapter (client.ts), as does all use of it: callers never discover the
   *  effective URL, and nothing protocol-specific crosses the boundary. */
  readonly fallbackServerUrl: string | null;
}
export interface OpenCodeClient {
  /** Wake-coalescing check (bridge.mjs:102-106): the adapter performs the GET
   *  /api/session/{sessionId}/inbox call AND the item.type === "user" interpretation
   *  internally; the caller receives only a protocol-neutral boolean. */
  hasPendingUserInput(sessionId: string): Promise<boolean>;
  /** POST /api/session/{sessionId}/prompt (bridge.mjs:86-92). The adapter sends
   *  `delivery: "queue"` internally — preserving the bridge's queued delivery;
   *  the port exposes no delivery parameter or any other request option. */
  prompt(sessionId: string, text: string): Promise<void>;
  /** Auth: Basic opencode:<password from ~/.config/opencode/service.json>, absent = none (bridge.mjs:64-73). */
  // Upstream calls carry a timeout per decision 4.
}

// events.ts — owns ALL OpenCode interpretation; emits protocol-neutral normalized items.
// Nothing downstream sees OpenCode wire shapes, event-type names, or inbox-item markers.
export interface SessionResolution {
  readonly name: string;              // domain actor name from the registry mirror (boss or agent)
  readonly role: "boss" | "agent";
}
/** Provided by the application (agents-module registry state) — supplies domain NAMES; all interpretation stays here. */
export type SessionResolver = (sessionId: string) => SessionResolution | null;

export type NormalizedEvent =
  // Human input captured from an inbox item: adapter maps item.type === "user" to
  // normalized semantics (from = "human", to = resolved session-owner name).
  | { readonly kind: "inbox"; readonly from: string; readonly to: string; readonly body: string; readonly sessionId: string; readonly ts: string }
  // Session-reply capture (session.text.ended with text in a resolvable session):
  // from = resolved session name; to = null — chat routes it (last-prompt record / boss fallback).
  | { readonly kind: "reply"; readonly from: string; readonly to: string | null; readonly body: string; readonly sessionId: string; readonly ts: string };

export interface OpenCodeEventStream {
  /** Subscribes; auto-reconnects after 5s on drop (bridge.mjs:211). Handler errors must not kill the stream.
   *  Unresolvable or unknown sessions produce NO event (bridge.mjs:165 skip semantics), not "ignored" noise. */
  subscribe(handler: (event: NormalizedEvent) => void | Promise<void>, resolveSession: SessionResolver): () => void;
}
/** The exact wake-slice line format the adapter composes and, if such an item is ever
 *  normalized, parses back — the `[time] [from: X] [to: Y] text` markers (bridge.mjs:117)
 *  are mapped into from/to fields HERE, never downstream. Today the boss agent consumes
 *  these markers natively; wake items are filtered as echoes before capture (§6 note). */
export const WAKE_PROMPT = "[message received]";
/** Pure, unit-tested. Raw SSE envelope + session resolution → NormalizedEvent | null.
 *  Performs ALL OpenCode interpretation: event-type mapping, session-reply capture
 *  detection, inbox-item semantics, wake-marker parsing. Makes NO capture-policy decisions
 *  (what to store) — that is chat application policy over normalized items. */
export function normalizeServerEvent(
  raw: { type: string; data?: unknown },
  resolveSession: SessionResolver,
): NormalizedEvent | null;

// sessions.ts — no raw inbox items cross the boundary; the adapter keeps the
// GET /api/session/{id}/inbox wire shape and the item.type === "user" check internal.
export interface OpenCodeSessionPort extends Pick<OpenCodeClient, "hasPendingUserInput"> {}

// prompts.ts
export interface OpenCodePromptPort { prompt(sessionId: string, text: string): Promise<void> }
```

**Boundary split (stated explicitly, per coordinator ruling):**
- **`integrations/opencode` owns every OpenCode-specific act:** SSE `data:`-envelope parsing, event-type mapping (`session.inbox.enqueued` / `session.text.ended`), session-reply capture *detection*, mapping inbox-item semantics (`item.type === "user"` → normalized `from: "human"`, `to` = resolved session owner), the inbox-coalescing interpretation (`hasPendingUserInput` performs the inbox fetch and the `type === "user"` check internally), the prompt delivery choice (`delivery: "queue"`, preserving the bridge's queued delivery — `bridge.mjs:86-92`), server-URL discovery, and `[from/to]` wake-marker parsing. It exposes only protocol-neutral results: the `{kind, from, to, body, sessionId, ts}` shape, a boolean, and a void prompt acknowledgement — no protocol-v2 identifiers, no OpenCode wire shapes, no OpenCode request options, no OpenCode session markers downstream. Domain names arrive via the injected `SessionResolver` (application-owned registry state) — the adapter interprets, it does not know the registry.
- **Chat application classifies only in domain terms, using its own state:** the **boss-only filter** compares the normalized item's `to` against the boss name from its registry state (domain name comparison, not an OpenCode type check); **echo detection** compares the normalized `body` against the wake text *it itself enqueued* (the application's record of prompts it sent — the ruling's own example; `WAKE_PROMPT` is the constant the application passed to the adapter's prompt composer). Capture policy — what gets stored — is chat's; shape interpretation is the adapter's.

This restores consistency with the binding rule "no OpenCode-specific logic outside `integrations/opencode`" (`MIGRATION.md:157`): after the adapter, the application sees only normalized items, domain names, and its own state. All payload fields typed; malformed/unknown raw shapes → `null` (no `any`).

---

## 7. API/event boundaries

**Legacy preserved exactly (decision 2):**
- `GET /api/messages?view=&after=&before=&limit=` → `{messages: {id, time, from, to, text}[], hasMore}`; views `all|boss|agent:<name>|project:<name>` (project resolves agent names from the registry); `before` wins over `after`; default limit 10 with negative clamp (`bridge.mjs:266-286`); `hasMore` = fetch-direction semantics (`store.mjs:81-91`).
- `GET /api/agents` → `[{name, project}]` only (session ids never exposed, `bridge.mjs:255-264`).
- `POST /send` `{to, message, from}` → `{sent, skipped}`; 400 empty message / bad sender / invalid JSON; 404 no targets; 500 no server URL; saved-row `to` = joined successful targets (`bridge.mjs:390-443`).
- `POST /prompt` `{message}` → `{status: "ok"}`; 400 empty; 500 no server URL (`bridge.mjs:365-388`).
- `POST /webhook` `{from, message}` → `{status: "ok"}`; legacy capture path kept (`bridge.mjs:342-363`).
- `/ui` + `/ui/*` static with today's cache headers (`bridge.mjs:220-253`).

**Flagged (needs decision, recommend reimplement):** `GET /api/last-activity` (`{all, boss, "agent:<name>"} → ts|null`) and `GET `/api/local-projects` (string[]) — used by today's dashboard (`api.ts:68-74`), absent from decision 2. `/api/stream` is superseded by `/api/events`.

**New SSE `GET /api/events` (adopted ruling: one shared monotonic event sequence):** the event bus writes every event to a single persisted `events` table `(id INTEGER PRIMARY KEY, type TEXT, payload TEXT/JSON, ts TEXT)` — ids come from that one sequence for ALL event types: `message.created` (payload = wire message row; the message row remains the source of truth for message content, the event row exists for ordering/cursor), `agent.status_changed`, `project.updated`. Each SSE frame carries `id: <events.id>`, `type:`, JSON `data:` (the event payload). Heartbeat comment frames (25 s, matching today, `bridge.mjs:313-317`). **Reconnect catch-up via `Last-Event-ID`:** one cursor, one sequence — on reconnect the server replays `events` rows with `id > lastEventId` in id order, regardless of type; message *content* for replayed `message.created` rows is served from `messages` by the id recorded in the event payload. Because ids are shared, an `agent.status_changed` with id 100 followed by a message with id 50 is impossible by construction (id 50 < 100 would have been written first). This also resolves the former Phase 2 open question: no snapshot-then-events fallback is needed, and no id mapping between messages and events exists. no WebSockets.

**Auth/validation (decision 4):** bind `127.0.0.1` by default; 1 MB body limit; zod validation on every HTTP input and on every OpenCode event payload at the adapter boundary; upstream request timeouts; optional bearer-token auth for `/send` + `/prompt` from a gitignored config file — file absent = open local access, a present-but-empty or malformed file = startup error (fail loud), documented. No user accounts.

**No business logic in route handlers:** handlers validate (zod) → call application services → map errors to HTTP; SSE endpoint only wires the bus to the response.

---

## Verification

No commands were run for this phase (read-and-write-document task; no code changed, no tests to run). All claims are source-cited above; unverified items are labeled §1 and §0.
