# @agents-lobby/server

Phase 2 backend foundation (Fastify 5 + TypeScript strict + Drizzle ORM +
better-sqlite3 + zod + vitest). See `docs/migration/assessment.md` and
`MIGRATION.md` for the binding context.

## Run

```sh
npm install            # from repo root (npm workspaces)
npm run dev -w server  # http://127.0.0.1:3006
npm run build -w server
npm test -w server
```

## Config

Defaults let a fresh clone run with no `.data/` and no `agents.json`.
Environment variables (all optional — see
`src/infrastructure/config/index.ts` for the full table):

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOBBY_HOST` | `127.0.0.1` | Bind address (local trusted environment). |
| `LOBBY_PORT` | `3006` | Dev port; 3005 stays the legacy bridge until cutover. |
| `LOBBY_BODY_LIMIT` | `1048576` | Max request body bytes (1 MB). |
| `LOBBY_DB_PATH` | `.data/dev.db` | SQLite file (gitignored, auto-created). Relative to cwd. Never points at the canonical db. |
| `LOBBY_OPENCODE_TIMEOUT_MS` | `30000` | Upstream OpenCode timeout (adapter, Phase 3). |
| `LOBBY_OPENCODE_SERVER_URL` | none | Fallback OpenCode URL; discovery stays inside the Phase 3 adapter. |
| `LOBBY_REGISTRY_PATH` | `config/agents.json` | Registry file, re-read per request (bridge-faithful). Absent file = empty registry (fresh clone); a present-but-malformed file fails that request (500). |

**Auth:** optional shared-secret bearer token read ONLY from the gitignored
file `.data/server.auth.json` (`{ "authToken": "..." }`). Absent file = open
local access, matching today's bridge; a present-but-empty, whitespace-only,
or malformed file = startup error (fail loud — the operator created the file
to protect something). When set, `/api/events`, `/send` and `/prompt` require
the `Authorization: Bearer <token>` header; read routes and `/webhook` stay
open (the bridge has no auth there either).

## API

Phase 2/3:
- `GET /api/health` → `{ "status": "ok" }`
- `GET /api/events` — SSE; `Last-Event-ID` header replays persisted events
  (single shared monotonic sequence in the `events` table) in id order, then
  streams live. Heartbeat comment every 25 s. No WebSockets.

Phase 5 (agents module):
- `GET /api/agents` → `[{ name, project }]` in agents.json file order — the
  bridge's exact shape (bridge.mjs:255-264; no session, no boss entry).
  Served from the read-only mirror tables, which are refreshed on every
  request (the bridge re-reads the file per request). Absent agents.json →
  `200 []`; a present-but-malformed file → 500 `registry_unavailable`
  envelope (consistent with the Phase 4 reader; the bridge exits instead).
  Any query string → 404 envelope with the bridge's message text `not found`
  (the bridge exact-matches the request URL, bridge.mjs:255,445).
  No registry CRUD (decision 3).

Phase 4 (chat module — bridge-compatible semantics, `bridge.mjs` references):
- `GET /api/messages?view=&after=&before=&limit=` → `{ messages: WireMessage[], hasMore }`;
  views `all|boss|agent:<name>|project:<name>` (project resolves its agent
  member names from the per-request registry read); `before` wins over `after`;
  default limit 10 (`''`/`0` → 10, the bridge's `Number(x) || 10` arithmetic);
  garbage/negative/fractional numbers → 400 envelope (zod, decision 4).
- `GET /api/last-activity` → `{ all, boss, "agent:<name>" } → ts|null` over the
  registry's agents (bridge.mjs:288-294).
- `POST /send` `{ to, message, from? }` → `{ sent, skipped }` (fan-out with the
  bridge's semantics: `Human:`/`Boss:` prefix, one prompt per target, per-target
  error isolation, saved row's `to` = joined SUCCESSFUL targets). 400 empty
  message / non `human|boss` sender; 404 no matching targets.
- `POST /prompt` `{ message }` → `{ status: "ok" }` (prompts the boss session).
- `POST /webhook` `{ from?, message? }` → `{ status: "ok" }` (legacy capture
  path, `bridge.mjs:342-363`, with the bridge's TRUTHINESS semantics: sender =
  `from || "unknown"` — any truthy JSON type passes to the store as-is;
  receiver NULL, `session_id` NULL, body trimmed; then the same coalesced boss
  wake — not awaited, `bridge.mjs:357`). Any falsy/whitespace `message` → 400
  `message is required`; a truthy non-string `message`, JSON `null` bodies,
  malformed/empty bodies and save-path failures → the bridge's blanket-catch
  400 `Invalid JSON` (content-type-agnostic raw `JSON.parse`).

All error responses use the shared envelope `{ error: { code, message, details? } }`.
The legacy bridge returns plain `{ error: "..." }` strings — the new stack keeps
the same STATUS codes but envelopes the body (documented Phase 4 deviation).

## Layout

```
src/
  infrastructure/{database/{schema.ts,migrations/,client.ts},events/,config/,registry/}
  integrations/opencode/{index,client,events,sessions,prompts}.ts
  modules/chat/{domain,application,infrastructure,presentation}
  modules/agents/{domain,application,infrastructure,presentation}
  api/{routes,middleware,plugins}
  shared/{types,schemas,errors}
  app.ts  server.ts
test/     vitest suites
```

`modules/projects` arrives when a project-domain consumer exists (the
`projects` mirror TABLE is live in Phase 5; no speculative query layer).

## Chat module (Phase 4)

`src/modules/chat/` is the first domain module:

- `domain/` — pure rules: message/view types, the wake-slice filter
  (`wakeSliceRows`, bridge.mjs:111-113), the HTTP query arithmetic
  (`parseMessageQuery`, bridge.mjs:270-275). No Fastify, no drizzle.
- `application/` — `ChatService`: capture policy (boss-only filter + wake-echo
  suppression of the enqueued wake text, bridge.mjs:166-185; boss
  `text.ended` replies capture UNCONDITIONALLY — Boss ruling 2026-11-19,
  option (d): the reply to a wake is the relay the human reads), reply routing
  via the in-memory `lastPromptFrom` map with the `"boss"` fallback
  (bridge.mjs:195), `/send` fan-out (bridge.mjs:390-443), `/prompt` to boss,
  and the wake orchestration (single-flight — each attempt queues behind the
  in-flight one and re-checks after it completes, so overlapping wakes cannot
  deliver the same rows twice — then coalescing → slice → prompt →
  bookmark-through-the-slice, bridge.mjs:98-130).
  Ingest is ATOMIC: message row + `message.created` event commit together
  through `EventBus.transaction()` (BEGIN IMMEDIATE + busy_timeout). A busy
  ingest retries within a 15 s budget: every attempt's SYNCHRONOUS driver wait
  is capped (250 ms) and the retries are separated by an async nap that YIELDS
  the event loop (timers/HTTP/SSE keep running while a contended capture
  retries); the cap is re-measured against the remaining budget, and the
  connection's saved busy_timeout is restored afterwards (the connection is
  shared with the agents/projects mirror writes, which have no retry loop).
  The whole read-cap-restore section is serialized through an in-process async
  ingest chain (waiters AWAIT — no synchronous blocking), so overlapping saves
  cannot snapshot another save's temporary cap as their "original" value.
  Exhaustion is loud — `CAPTURE LOST` with the row's IDENTIFYING metadata
  (from/to/ts/sessionId/body length; the body itself is redacted, message
  content never reaches the logs) — and rethrows; it is never silently
  dropped. A skipped duplicate persists no `message.created` (nothing was
  created).
- `infrastructure/` — `ChatMessageRepository`: a verbatim SQL port of
  `store.mjs` (same tables, same views/pagination/bookkeeping/lastActivity);
  equivalence with `store.mjs` is asserted in `test/chat-store.test.ts`
  including against `server/.data/verify-copy.db` (a read-only COPY of the
  canonical db — never touched). Its `insert()` also carries the insert-dedup
  guard, restricted to EVENT CAPTURES (the OpenCode-listener path): a
  duplicate capture of the same event (same sender + null-safe receiver +
  body within a 100 ms window around the incoming capture ts) is skipped +
  logged, never stored; explicit
  `/send` and legacy `/webhook` inserts are never deduped. The db-level
  check holds across connections (the dual-instance failure mode, canonical
  rows 1461/1462/1463/1464): the ingest transaction takes the write lock at
  BEGIN (`BEGIN IMMEDIATE`) and the connection busy_timeout makes a second
  instance wait, then see the committed duplicate.
- `presentation/` — thin Fastify routes (zod validation + envelope only).

**Registry:** `src/infrastructure/registry/reader.ts` re-reads `agents.json` on
EVERY read (bridge-faithful; a file swap is reflected on the next request). The
registry FILE stays the runtime source of truth (decision 3) — chat reads the
registry directly through its port; the agents module refreshes the `agents`
mirror from the same snapshot. The
session resolver for the Phase 3 event stream re-reads the registry per event
line, exactly like the bridge listener.

**Adapter fallback precedence** (documented, tested in `test/app-wiring.test.ts`):
effective OpenCode server URL = discovery (`opencode service status`, inside the
adapter) > `LOBBY_OPENCODE_SERVER_URL` env > `agents.json` `serverUrl`
(bridge.mjs:31 — only an http(s)-looking value qualifies; read once at startup).

## Agents module (Phase 5)

`src/modules/agents/` mirrors agents.json into the db (decision 3 — the FILE
stays the runtime registry):

- `domain/` — pure types (`Agent`, `RegistrySnapshot`, the `{name, project}`
  wire projection) and `projectNames` (distinct grouping strings,
  bridge.mjs:277-282). Registry types are structurally identical to the chat
  module's — the shared reader satisfies the port with no cross-module import.
- `application/` — `AgentsService`: startup sync (`syncStartup`, bridge reads
  the file once at startup, bridge.mjs:14-19) and per-request re-read +
  mirror refresh (`sync`/`listAgents`, bridge.mjs:45-49,255-264). NO CRUD.
- `infrastructure/` — `AgentMirrorRepository`: full-rewrite replace of the
  `agents` + `projects` tables in one transaction (`ordinal` preserves file
  order for the bridge-identical response).
- `presentation/` — `GET /api/agents` (thin; no query params — the bridge
  accepts none, bridge.mjs:255).

**Schema note:** `projects` holds the DISTINCT project grouping strings of the
registered agents; `agents` mirrors the agents.json `agents` entries exactly
(`{name, project, session}` + `ordinal`). The boss is NOT mirrored in the db
(it is not part of the agents.json `agents` array and never reaches
/api/agents); it is read from agents.json itself on every registry read.
`agents` is ROWID-KEYED (no name PK): the bridge serves ALL entries including
duplicate names (bridge.mjs:258) — uniqueness is not part of the agents.json
contract and is not enforced.
No FK/id columns: project is a plain grouping string in the registry and the
dashboard aggregates client-side (bridge.mjs:288-290). The Phase 4
`registry_mirror` table was dropped by migration `0004` (dual-mirror
consolidation).

## OpenCode integration (Phase 3)

`src/integrations/opencode/` is the ONLY place with OpenCode-specific logic.
The stable internal interface is `index.ts` → `createOpenCodeIntegration(config)`
returning the three protocol-neutral ports ONLY (no Fastify, no drizzle, no
routes; the effective `serverUrl`, raw `request`/`stream` transport, and the
discovery override stay internal — `client.ts` is a module-path test seam, not
part of the exported integration type). **Errors from the ports are NEUTRAL:**
`PortError {code, message}` only (`unavailable | timeout | upstream-error |
invalid-response`); the rich internal `OpenCodeRequestError` (URL, pathname,
HTTP status, raw body) is logged inside the adapter and never crosses the
entry point:

- `events.subscribe(handler, resolveSession)` — SSE `/api/event` subscription
  (port of the bridge listener): zod validation at the trust boundary, session-reply
  capture and inbox-item semantics interpreted INSIDE, emitted as
  `NormalizedEvent {kind: inbox|reply, from, to, body, sessionId, ts}`. The `handler`
  is the injectable sink Phase 4 (chat) will connect to its capture policy + the
  event bus. Bounded-exponential reconnect, capped at the bridge's flat 5 s;
  unsubscribe aborts the in-flight stream.
- `sessions.hasPendingUserInput(sessionId)` — wake-coalescing check; the inbox
  wire shape and the `type === "user"` interpretation stay internal (bridge.mjs:102-106).
  `createSessionResolver(loadRegistry)` maps session handles → domain actor names
  exactly as the bridge listener does (boss first, fixed name `"boss"`).
- `prompts.prompt(sessionId, text)` — POST prompt with `delivery: "queue"`
  adapter-internal (bridge.mjs:86-92). **`prompts.isAvailable()`** — the neutral
  availability check (bridge's `!SERVER_URL`, as a boolean; Phase 4 review
  ruling): TRUE only when an effective server URL was resolved at creation —
  no URL/transport detail crosses. **`lastPromptFrom` split (adjudication):** the
  who-prompted-whom map is Phase 4 chat's application state; the adapter contributes
  the ack signals — `prompt()` resolving = delivered (chat records `lastPromptFrom`
  BEFORE awaiting, bridge.mjs:416), rejecting = skipped. **Boss wake:** the wake
  TEXT format is adapter-owned and BYTE-IDENTICAL to the bridge (`WAKE_PROMPT`,
  `composeWakePrompt`, `formatWakeLine`, `parseWakeLine`; asserted byte-for-byte
  against `bridge.mjs` in `test/opencode-prompts.test.ts`). Slice CONSTRUCTION
  (unread-row selection, bookmark advance, empty-slice semantics, bridge.mjs:111-124)
  is Phase 4 chat.
- Effective server-URL discovery (`opencode service status` → first-line URL)
  and the Basic-auth read of `~/.config/opencode/service.json` happen inside
  `client.ts` (bridge.mjs:22-73); callers may inject only the CONFIGURED fallback
  URL (`LOBBY_OPENCODE_SERVER_URL` / `agents.json` `serverUrl`). Upstream
  request/response calls carry a timeout (decision 4); the long-lived SSE stream
  has none by contract — drops are handled by the reconnect loop.
