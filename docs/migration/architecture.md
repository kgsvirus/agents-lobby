# Agents-Lobby — Final Architecture (post-migration record)

**Date:** 2026-11-17 · **Status:** Phase 7A record of the implemented system in this
worktree (branch `feat/migration`, working-tree changes). Every claim cites a real
path/file in this worktree; items not verifiable from source are labeled.
Companion documents: `docs/migration/assessment.md` (pre-migration analysis,
including the legacy behavior citations), `MIGRATION.md` (work order),
`server/README.md` (operator-facing API/config reference).

**Strangler position:** this stack is NOT yet canonical. The legacy bridge
(`bridge.mjs`, port 3005) still runs in `F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby`
and remains canonical until the Boss performs the cutover
(`docs/migration/cutover/migration-runbook.md`). The old dashboard (`src/` →
`dist/`) still serves from the bridge. Nothing in the canonical worktree was
touched by the migration.

---

## 1. Final directory structure

```
agents-lobby/
  package.json               # npm workspaces ["server","web"], engines node >=24;
                             # legacy Vite scripts (dev/build → src/) still present
                             # until cutover removes them (Boss's call)
  vitest.config.ts           # scopes vitest to server/test/** + web/test/**
                             # (legacy test/*.mjs stays on node --test)
  bridge.mjs, store.mjs,     # LEGACY — deleted at cutover (Boss does it;
  src/, dist/,               # work order §6 "delete obsolete bridge code only
  local-projects.mjs,        # at cutover")
  test/, vite.config.ts
  server/                    # NEW backend (Fastify 5 + TS strict + better-sqlite3/
    package.json             #   drizzle-orm + zod; scripts: dev=tsx src/server.ts,
    tsconfig.json            #   build=tsc, test=vitest run, db:generate=drizzle-kit)
    src/
      server.ts              # entry: loadConfig() → buildApp() → listen (src/server.ts)
      app.ts                 # composition root: db + migrations + bus + registry +
                             #   OpenCode adapter + chat/agents/projects wiring + routes
                             #   (server/src/app.ts); tests inject fake ports here
      api/                   # cross-module HTTP layer
        routes/health.ts     # GET /api/health
        routes/events.ts     # GET /api/events (SSE; §3)
        routes/ui.ts         # /ui + /ui/* static export of web/out
        middleware/auth.ts   # optional bearer check (decision 4)
        plugins/error-handler.ts  # AppError → shared envelope
      modules/
        chat/                # domain/ (message, query — pure), application/
                             # (chat-service: capture, routing, fan-out, wake),
                             # infrastructure/ (message-repository: verbatim store.mjs
                             # SQL port), presentation/ (thin routes)
        agents/              # domain/ (agent.ts), application/ (agents-service:
                             # startup + per-request sync, listAgents),
                             # infrastructure/ (agent-mirror-repository),
                             # presentation/ (GET /api/agents)
        projects/            # application/ (projects-service), infrastructure/
                             # (local-projects-reader: port of local-projects.mjs),
                             # presentation/ (GET /api/local-projects)
                             # — created in Phase 6 fix round; NO speculative layers
      integrations/opencode/ # index.ts (stable entry), client.ts (discovery/auth/
                             #   transport, test seam), events.ts (SSE subscribe +
                             #   normalize), sessions.ts (inbox port + session
                             #   resolver), prompts.ts (prompt port + wake text),
                             #   errors.ts (PortError)
      infrastructure/
        database/{client.ts,schema.ts,migrations/}   # drizzle; migrations 0000–0004
        events/bus.ts        # in-process bus; publish = persist to `events` + fan-out
        config/index.ts      # zod-validated env (§ server/README.md table)
        registry/reader.ts   # JsonRegistryReader — agents.json re-read per request/
                             #   event line (no db writes; registry_mirror dropped)
      shared/{types,schemas,errors}/   # event payload schemas, wire schema, envelope
    test/                    # 23 vitest files (incl. AST surface guard, migration
                             #   equivalence, ui-static)
    .data/                   # dev-only: dev.db, verify-copy.db (READ-ONLY copy of the
                             #   canonical db used by tests), server.auth.json (opt.)
  web/                       # NEW frontend (Next.js 15 App Router + React 19 +
    package.json             #   Tailwind v4; output:'export', basePath '/ui')
    next.config.ts           # static export + dev-only rewrites → :3006
    src/
      app/                   # layout.tsx (theme bootstrap script), page.tsx, globals.css
      App.tsx                # dashboard shell (client-side only; no SSR/db/Server Actions)
      components/            # TopNav, Sidebar, ProjectsSidebar, ChatFeed,
                             # MessageBubble, Composer, ui/button.tsx (shadcn Button)
      hooks/                 # useMessages.ts (ported verbatim; I1/M2 drain intact),
                             # useTheme.ts
      lib/                   # api.ts (envelope-aware client), theme.ts, utils.ts (cn)
    test/                    # 7 vitest files (44 tests)
```

Layer rule (binding, work order §6): `modules/*/domain` and `modules/*/application`
import neither Fastify, nor drizzle, nor OpenCode wire shapes — persistence and HTTP
live in `infrastructure/` / `presentation/` / `api/`. Routes are validation +
delegation only (checked per-file: e.g. `server/src/modules/chat/presentation/routes.ts`).

**Recorded deviation — `modules/activity` intentionally NOT materialized** (vs
MIGRATION.md §3's reference layout, Phase 7A review ruling): the work order's
layout is "reference, adapt — no empty folders, no speculative layers", and no
current use case exists for an activity-feed domain — the only activity-like
need today is last-activity stamps (served by the chat module's repository) and
the event feed, which lives in the shared infrastructure bus
(`infrastructure/events/bus.ts` + `events` table) and is consumed via SSE
(`GET /api/events`). The bus is already module-independent (raw better-sqlite3
handle, no Fastify/drizzle), so a future activity module can adopt it without
reshaping anything. **Revisit trigger:** a real activity-feed use case (e.g. a
publisher for `agent.status_changed` / `project.updated`, or server-side
activity queries).

## 2. Module boundaries

| Concern | Home |
|---|---|
| Message rows, views (`all\|boss\|agent:<name>\|project:<name>`), pagination/`hasMore`, bookmarks/unread, wake-slice row filter, HTTP query arithmetic | `modules/chat/domain/` (pure) + `modules/chat/infrastructure/message-repository.ts` (verbatim `store.mjs` SQL, alias `ts AS time, sender AS "from", receiver AS "to", body AS text`) |
| Capture policy (boss-only filter, wake-echo suppression of the enqueued wake text; boss `text.ended` replies capture UNCONDITIONALLY — Boss ruling 2026-11-19, option (d): the reply to a wake is the relay the human reads), reply routing via in-memory `lastPromptFrom` (`"boss"` fallback), `/send` fan-out, `/prompt`, wake orchestration (single-flight: each attempt queues behind the in-flight one and re-checks after it completes; then coalesce → slice → prompt → bookmark-through-slice) | `modules/chat/application/chat-service.ts` — all OpenCode-free: it compares domain names and its own outbox text |
| Insert-dedup guard (EVENT CAPTURES ONLY — the OpenCode-listener path; explicit /send + /webhook inserts are never deduped): a capture insert whose sender + receiver (null-safe) + body matches a row whose `ts` is within 100 ms of the incoming capture `ts` is skipped + logged at the repository's `insert()`; a skipped duplicate returns the existing row with `inserted:false` and publishes NO `message.created`; holds across connections via the ingest transaction's `BEGIN IMMEDIATE` + busy_timeout | `modules/chat/infrastructure/message-repository.ts` |
| Registry (`agents.json`) read: per-request (`read()`) and per-event-line (`loadSync()`) re-reads, no db writes | `infrastructure/registry/reader.ts`; chat and agents consume the reader through their own ports (no cross-module import). The FILE stays the runtime source of truth (MIGRATION.md decision 3) |
| Agents mirror (`agents` + `projects` tables, `ordinal` file order, rowid-keyed → duplicates preserved) | `modules/agents/` — startup sync + per-request refresh; serves `GET /api/agents` |
| Local projects listing | `modules/projects/` — filesystem readdir, ENOENT → `[]` |
| OpenCode protocol (SSE `/api/event`, inbox, prompt, discovery, auth, wake-text format) | `integrations/opencode/` ONLY — nothing else imports OpenCode shapes |
| Event bus, SSE endpoint, db client/migrations, config, HTTP auth/error mapping | `infrastructure/`, `api/` |

**Protocol-neutral boundary (`integrations/opencode/index.ts`):**

- Emits `NormalizedEvent` only: `{kind:'inbox'|'reply', from, to, body, sessionId, ts}`
  (`integrations/opencode/events.ts:36-42`). All OpenCode interpretation —
  `session.inbox.enqueued` / `session.text.ended` semantics, inbox-item
  `type === 'user'`, wake-marker parsing, session-reply detection — happens inside.
- Ports: `OpenCodeEventStream.subscribe(handler, resolveSession)`,
  `OpenCodeSessionPort.hasPendingUserInput(sessionId): Promise<boolean>`,
  `OpenCodePromptPort.prompt(sessionId, text): Promise<void>` +
  `isAvailable(): boolean`. `prompt()` resolving = delivered ack (chat records
  `lastPromptFrom` BEFORE awaiting, `bridge.mjs:416` order); rejecting =
  skipped. Queue delivery (`delivery:'queue'`) is adapter-internal
  (`integrations/opencode/prompts.ts:3-8`).
- Errors crossing the boundary are neutral `PortError {code, message}`
  (`integrations/opencode/errors.ts`); rich transport detail is logged inside.
- **Export whitelist + AST guard** (`server/test/opencode-client.test.ts:150-304`):
  `index.ts` may export exactly 15 names — `NormalizedEvent`, `SessionResolution`,
  `SessionResolver`, `SessionRole`, `OpenCodeEventStream`, `OpenCodeSessionPort`,
  `OpenCodePromptPort`, `PortError`, `PortErrorCode`, `OpenCodeIntegration`,
  `OpenCodeIntegrationConfig`, `createOpenCodeIntegration`, plus the three
  CONSCIOUSLY exported documented split points `createSessionResolver`,
  `composeWakePrompt`, `WAKE_PROMPT` (added in the Phase 7A review round so the
  composition root and chat consume ONLY the entry surface — no module-path
  reach-ins) — asserted in every export form via the TypeScript AST; star
  re-exports and default exports are structurally rejected. Runtime value
  exports pinned to `['PortError', 'WAKE_PROMPT', 'composeWakePrompt',
  'createOpenCodeIntegration', 'createSessionResolver']`.
- Wake-prompt format (`WAKE_PROMPT = "[message received]"`, `composeWakePrompt`,
  `formatWakeLine`, `parseWakeLine`) is adapter-owned and pinned byte-identical to
  `bridge.mjs:94,114-118` by `server/test/opencode-prompts.test.ts` (extracts the
  literal from `bridge.mjs` source). Slice CONSTRUCTION (unread selection,
  bookmark advance, empty-slice semantics) is chat's
  (`modules/chat/domain/message.ts wakeSliceRows` + `chat-service.ts`).

## 3. API / event contract

All under the new server; POST-cutover production port **3005** (decision 5), dev
**3006**. Success shapes are byte-compatible with the bridge; error bodies use the
shared envelope `{error:{code, message, details?}}` (`shared/errors/index.ts`) —
standing ruling: envelope shape is the one documented deviation, STATUS codes and
message TEXTS stay bridge-identical.

| Endpoint | Semantics (source) |
|---|---|
| `GET /api/health` | `{status:'ok'}`, no auth (`api/routes/health.ts`) |
| `GET /api/messages?view=&after=&before=&limit=` | `{messages:[{id,time,from,to,text}], hasMore}`; views `all\|boss\|agent:<name>\|project:<name>` (project members from the per-request registry read); `before` wins over `after`; default limit 10 (`''`/`0`→10); valid inputs keep the bridge's exact arithmetic, garbage/negative/fractional → 400 envelope (documented zod tightening; `modules/chat/domain/query.ts`, `presentation/routes.ts:43-48`) |
| `GET /api/last-activity` | `{all, boss, "agent:<name>"} → ts\|null` over registry agents (`chat/presentation/routes.ts:68`) |
| `GET /api/agents` (EXACT path) | `[{name, project}]` in agents.json file order, no session/boss; any query string → 404 envelope, bridge message text `not found` (exact-URL guard, `agents/presentation/routes.ts:25-37`); absent agents.json → `200 []` (fresh-clone default; the bridge exits instead — documented delta); malformed file → 500 `registry_unavailable` |
| `GET /api/local-projects` | `string[]` from `LOBBY_PROJECTS_DIR` (default `./projects`); query strings ALLOWED (bridge matches pathname only here); readdir failure → 500 envelope, message = the fs error's message (`projects/presentation/routes.ts`) |
| `POST /send` `{to, message, from?}` | `{sent, skipped}`; `from` restricted `human\|boss` (400 `from must be 'human' or 'boss'`); `to:'all'` → all registry agents, else name match or array membership (ALL matching entries incl. duplicates, file order); 404 `no matching agents for: <JSON>` on no targets (incl. `to:[]`); 500 `upstream_unavailable` (`OpenCode server URL not discovered`) fail-fast checked after sender/empty-message, before targets; saved row `to` = comma-joined SUCCESSFUL targets, none saved when all fail; per-target `Human:`/`Boss:` prefix |
| `POST /prompt` `{message}` | `{status:'ok'}`; 400 `message is required` (empty after trim); 500 `upstream_unavailable` before the registry check (bridge order); capture is the listener's, the route stores nothing |
| `POST /webhook` | Legacy capture: bridge TRUTHINESS semantics — any defined-JSON body accepted (zod `z.unknown()`), falsy `message` → 400 `message is required`, truthy non-string `message` / malformed / empty body / save-path failure → 400 `Invalid JSON` (replicated legacy blanket-catch, pinned by comment + tests, `chat/presentation/routes.ts:80-111`); content-type-agnostic raw `JSON.parse`; sender `from \|\| "unknown"`, receiver NULL, then un-awaited coalesced wake. NOT token-gated |
| `/ui`, `/ui/*` | Static serving of the `web/out` export (`api/routes/ui.ts`): dot-dot stripping; `.html` → `no-cache`; hashed assets (`assets/`, `_next/static/`) → `public, max-age=31536000, immutable`; miss → bare 404. `web/next.config.ts` sets `basePath:'/ui'` so every asset ref is `/ui/`-prefixed (tested against the real export) |
| `GET /api/events` | SSE - see below. NOT token-gated (decision-4 scope: /send + /prompt only) |

**Optional auth (decision 4, final-review scope ruling):** bearer token from the
gitignored `.data/server.auth.json` (`{authToken}`); absent file = open local
access; empty/malformed file = startup error (fail loud). When set, ONLY
`/send` and `/prompt` require `Authorization: Bearer`; `/api/events` (SSE),
the other reads (`/api/messages`, `/api/agents`, `/api/last-activity`,
`/api/local-projects`), `/ui` and `/webhook` stay open
(`api/middleware/auth.ts`, `config/index.ts`, `chat/presentation/routes.ts:5-6`).
Known limitation: with a token set, the dashboard composer's `/send`/`/prompt`
calls return 401 - the UI has no token entry and the secret is never embedded
in the web bundle. The dashboard is a same-host trusted-client UI; token-based
UI auth is a post-cutover follow-up (operator: remove the auth file to use the
dashboard, or send via a token-aware client).

**SSE contract (`api/routes/events.ts`):**

- Frames: `id: <events.id>`, `event: <type>`, `data: <JSON>`. Heartbeat comment
  every 25 s (bridge-identical, `bridge.mjs:313-317`).
- Event types: `message.created` (payload = the wire message row, resolved fresh
  from the `messages` table by the id in the event payload; a missing row skips
  the frame but still advances the cursor), `agent.status_changed`
  `{name, status}`, `project.updated` `{name}` (`shared/schemas/events.ts`).
  **Recorded fact:** only `message.created` has a publisher today (chat ingest);
  the other two types have schemas and replay paths but no emitting code yet —
  the UI ignores them (`web/src/lib/api.ts` listens to `message.created` only).
- **Single shared monotonic sequence:** every event is persisted to the `events`
  table (`id` AUTOINCREMENT shared by ALL types — `infrastructure/events/bus.ts`),
  which is the ONLY `Last-Event-ID` cursor; a status event can never permanently
  shadow a later message by id.
- **Fresh connection (no `Last-Event-ID` header):** starts at the LIVE HEAD —
  NO history replay; the client does its initial REST backfill from
  `/api/messages`. A synthesized `lobby.checkpoint` frame (`id: <head>`, `data:
  {"head":<head>}`) seeds the native EventSource `lastEventId` so a later
  auto-reconnect ALWAYS carries a cursor, even after an event-free connection
  (route-synthesized, not a bus event; ignored by the UI).
- **Reconnect (header present):** header must be a digit-only safe integer →
  400 envelope otherwise; server replays persisted events `id > cursor` in id
  order regardless of type, then continues live. No gap between replayed tail
  and live stream (subscribe-before-head-read + buffered frames).

## 4. Adapter design (integrations/opencode)

- **Effective server URL precedence** (wired in `app.ts:89-105`, documented in
  `config/index.ts`): discovery inside the adapter (`opencode service status`,
  `client.ts`) > `LOBBY_OPENCODE_SERVER_URL` env > `agents.json` `serverUrl`
  (read once at startup; only an http(s)-looking, fully zod-valid URL qualifies —
  an invalid value is warned and treated as absent, `registry/reader.ts`).
  Discovery and Basic auth (`~/.config/opencode/service.json`) never leave
  `client.ts`; callers inject only the CONFIGURED fallback.
- **Ports:** `hasPendingUserInput(sessionId)` performs the inbox GET and the
  `type === 'user'` interpretation internally; `prompt(sessionId, text)` sends
  `delivery:'queue'` internally (no option crosses); `isAvailable()` = the
  bridge's `!SERVER_URL` check as a neutral boolean (chat fail-fasts `/send`,
  `/prompt`, wake with it).
- **lastPromptFrom / wake-slice split (adjudication):** the who-prompted-whom
  map is chat application state (in-memory, restart loses it → `"boss"`
  fallback — bridge-faithful, Boss-accepted); the adapter contributes only the
  prompt ack signals (resolve = delivered / reject = skipped). The wake TEXT
  format is adapter-owned and byte-identical; slice row selection + bookmark
  advance + empty-slice (no bookmark move) semantics are chat's
  (`modules/chat/application/chat-service.ts`, `test/chat-wake.test.ts`).
- Stream reconnect: bounded exponential backoff capped at the bridge's flat 5 s;
  handler rejections are caught and logged, the stream keeps running
  (`test/opencode-stream.test.ts` pins async rejections).

## 5. Migration strategy (db)

Migrations: `server/src/infrastructure/database/migrations/` (drizzle-kit,
journal `meta/_journal.json`), applied automatically at startup
(`app.ts:55-56` → `runMigrations` in `database/client.ts`).

- **`0000_tiny_union_jack.sql` — baseline.** Reproduces the legacy schema
  (`messages(id, ts, sender, receiver, body, session_id)`, `bookmarks(consumer,
  last_seen_id)`, both indexes) **plus the `events` table**, ALL `IF NOT EXISTS`
  — it applies cleanly to a fresh db AND to a populated legacy copy, leaving
  legacy tables/data untouched. Column names are the REAL `sender`/`receiver`/
  `body` (assessment §0 — the work order's `from`/`to` was a paraphrase); wire
  aliases stay at repository level.
- **Additive:** `0001_rare_thanos.sql` (+`registry_mirror`), `0002_neat_mordo.sql`
  (+`agents`, `projects`), `0003_heavy_scourge.sql` (rowid rebuild of both mirror
  tables with `INSERT…SELECT` data copy — SQLite cannot drop a name PK in place;
  preserves duplicates, keeps `ordinal`), `0004_heavy_thing.sql` (drops the
  write-only `registry_mirror` — dual-mirror consolidation; `agents`/`projects`
  is the remaining, consumed mirror). Existing columns are never
  dropped/renamed/retyped; no FKs (project is a free-form grouping string, no
  consumer — documented choice).
- **Copy verification:** `server/.data/verify-copy.db` is a byte COPY of the
  canonical db (751 rows) used read-only by the equivalence suites
  (`test/migration.test.ts` in-place migration + schema-pragma comparison
  against a store.mjs-DDL fixture; `test/chat-store.test.ts` 16-query matrix and
  wake equivalence against the real legacy `openStore()` over the same file).
  Canonical db was NEVER touched during development (decision 6).
- **Canonical db is migrated ONLY at cutover, by the Boss, after a backup**
  (`docs/migration/cutover/migration-runbook.md`); the runbook migrates a COPY
  first, then the real file.
- **Strangler sequence:** legacy bridge + old dashboard remain canonical on 3005
  → new stack verified in the dev worktree (dev port 3006) → Boss cutover
  (backup → migrate → start new server on 3005 → verification gates → rollback
  path) → obsolete bridge files (`bridge.mjs`, `store.mjs`, `src/`, `dist/`,
  `local-projects.mjs`, `test/*.mjs`, Vite config) deleted by the Boss at
  cutover (work order §6).

## Verification

Documentation task PLUS one scoped code change (Phase 7A review finding 8:
adapter split-point imports moved to the `integrations/opencode/index.ts` entry
surface — `index.ts` + conscious whitelist extension, `app.ts`,
`modules/chat/application/{chat-service,ports}.ts`, mock in `app-wiring.test.ts`).
Real gate output from the worktree root after the change: `npm run build -w
server` → exit 0 (tsc clean); `npx vitest run` → exit 0, **30 files / 234 tests
passed** (incl. the updated AST surface guard); `node --test test/*.test.mjs` →
exit 0 (7/7). All other claims verified against the actual source files in this
worktree (paths cited inline) and against the task reports under
`.superpowers/sdd/migration-work-order/` (task-5/7/8 for prior gate evidence).
The 751-row verify-copy count and the "no publisher for agent.status_changed /
project.updated" fact are as recorded above — the former from
`.superpowers/sdd/migration-work-order/task-5-report.md`, the latter from a
`grep` over `server/src`. Unverified: real runtime artifacts (canonical
`.data/messages.db`, real `agents.json`) were never opened, per work order.
