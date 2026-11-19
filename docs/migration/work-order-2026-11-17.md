# Agents-Lobby Architectural Migration — Work Order

**Issued by:** Boss agent (delegated authority from the human, 2026-11-17)
**Executor:** Coordinator (ruben) + its Developer / Reviewer subagents
**Status:** COMPLETE 2026-11-18 - cutover shipped in v1.3.0 (D26).

---

## 0. Assignment exclusivity

Your current assignment is **exclusively Agents-Lobby**. TaskFlow project
instructions, conventions, bookkeeping, and status files DO NOT apply to this
work order. Do not write TaskFlow state, do not run TaskFlow checks, do not
treat TaskFlow docs as context. Inspect the actual Agents-Lobby repository
(paths below) before making decisions.

## 1. Worktree topology (CRITICAL — read before touching anything)

- **Canonical worktree:** `F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby` — the
  STABLE RUNTIME. The bridge (`node bridge.mjs`, port 3005) runs there RIGHT
  NOW; the canonical message database is `.data/messages.db`; the live
  registry is `agents.json`. It serves the human's communication and must
  stay operational at all times.
- **Development worktree (yours):**
  `C:\Users\user\.local\share\opencode\worktree\07a179\lobby-migration`
  (branch `feat/migration`). ALL implementation happens here.
- **NEVER modify, delete, reset, clean, or commit anything in the canonical
  worktree. NEVER run the dev server against the canonical database.
  NEVER migrate `.data/messages.db` in place — the canonical db is migrated
  only at integration time, by the Boss, with a backup.**
- The dev worktree has NO `.data/`, NO `agents.json` (gitignored files don't
  propagate to worktrees). That is intentional: dev runtime resources are
  isolated. Dev config must provide sensible defaults so a fresh clone runs.

## 2. What Agents-Lobby is today (verify against source, don't trust blindly)

- `bridge.mjs` (~zero-dep Node HTTP server, port 3005): `/webhook`, `/send`
  (fan-out to agents via OpenCode prompt API), `/prompt` (webchat → boss),
  `/ui` (serves `dist/`), `/api/messages`, `/api/agents`. Event listener
  subscribes to the OpenCode server SSE and mirrors boss+agent sessions into
  the message store; wakes the boss with an inline unread slice.
- `store.mjs` + `.data/messages.db`: SQLite via `node:sqlite`, tables
  `messages(id, ts, from, to, body, session_id)` and
  `bookmarks(consumer, last_seen_id)`.
- Frontend: React + Tailwind + Vite at repo root (`src/`), built to `dist/`,
  served at `/ui`. Sidebar views (Boss/All/project/agent), chat feed,
  composer, dark/light theme.
- `agents.json` (gitignored): `serverUrl` fallback + registry of
  `{name, project, session}` entries; bridge re-reads it per request.
- Tests: `node --test test/*.test.mjs` (7 tests, store-level). Root scripts
  in `package.json`.

## 3. Target architecture (the human-approved direction)

- **Backend:** Node.js + TypeScript + **Fastify**, modular monolith. Domain
  logic independent of Fastify. Modules: `chat`, `projects`, `agents`,
  `activity` (activity = internal event/activity feed; no UI). OpenCode
  integration lives ONLY in `server/src/integrations/opencode/` behind a
  stable internal agent interface. NO microservices.
- **Frontend:** **Next.js** (App Router) + React + TypeScript + Tailwind +
  **shadcn/ui**. API-driven; no Server Actions business logic; no direct db
  access from the frontend. Preserve the existing Chat-room experience
  (sidebar views, alignment, composer, theme, wake slice semantics).
- **Database:** SQLite via **Drizzle ORM** + drizzle-kit migrations.
  Baseline migration must reproduce the EXISTING schema
  (`messages`, `bookmarks`) without data loss, then evolve additively
  (indexes, FKs, new tables only where a current use case exists).
- **Real-time:** SSE from the new backend (`/api/events`) backed by an
  internal event bus; events at minimum: `message.created`,
  `agent.status_changed`, `project.updated`. Reconnect + catch-up via
  `Last-Event-ID` (event rows persisted or recoverable from messages).
  NO WebSockets.
- **Layout (reference, adapt — no empty folders, no speculative layers):**

```
server/
  src/
    modules/{chat,projects,agents,activity}/{domain,application,infrastructure,presentation}
    integrations/opencode/{client,events,sessions,prompts}
    infrastructure/{database/{schema,migrations,client},events,config}
    api/{routes,middleware,plugins}
    shared/{types,schemas,errors}
web/          (Next.js app)
```

- Root `package.json` uses npm workspaces (`server`, `web`). Node 24.
  TypeScript strict.

## 4. Boss decisions already made (binding)

1. **Strangler migration.** The old bridge keeps running in canonical until
   the new stack is fully verified. No big-bang cutover.
2. **API compatibility:** during migration the new server must honor the
   existing API semantics for: `/api/messages` (views `all|boss|agent:<name>`,
   `after`, `limit`), `/api/agents`, `/send` (`to`, `message`, `from`),
   `/prompt`, `/ui` static serving. Internal shapes may evolve; external
   consumers (dashboard, boss wake) must not break at cutover.
3. **Registry:** `agents.json` REMAINS the runtime registry during this
   migration (bridge semantics preserved). The new `agents` + `projects`
   domain modules get db tables and load/sync from `agents.json` at startup
   (read-only mirror). Do not build registry CRUD UI yet.
4. **Auth model (local trusted environment):** bind to `127.0.0.1` by
   default; request body size limits (default 1 MB); upstream (OpenCode)
   request timeouts; validation of all inputs (zod); optional shared-secret
   auth for `/send` + `/prompt` (bearer token from a gitignored config file —
   absent file = local open access, matching today's behavior, documented).
   No user-account system.
5. **Ports:** new server runs dev on **3006**. Port 3005 stays the
   production port — the Boss performs the cutover (stop old bridge → start
   new server on 3005) only after Phase 7 acceptance.
6. **Data preservation:** baseline Drizzle migration against a COPY of the
   canonical db for verification. Canonical db itself is touched only at
   integration by the Boss.
7. **NO commits anywhere** (canonical or dev worktree) until the human
   authorizes. Work stays as working-tree changes in the dev worktree.
8. **Do not change the Boss agent's operational instructions** (`.opencode/
   agents/boss.md`, `.memory/boss/*`) — out of scope.

## 5. Execution phases

- **Phase 1 — Assessment (now):** inspect the canonical repo READ-ONLY.
  Produce `docs/migration/assessment.md` in the DEV worktree: real
  dependency map (bridge ↔ store ↔ listener ↔ ui), risk list, the target
  structure, module boundaries, db migration strategy, OpenCode adapter
  contract (interface signatures), API/event boundaries. Concise — this
  leads directly to implementation, not an essay.
- **Phase 2 — Backend foundation:** scaffold `server/` (Fastify + TS +
  Drizzle + zod + vitest), baseline migration reproducing `messages` +
  `bookmarks`, db client, config module, event bus + SSE endpoint, shared
  error/validation, health route. Tests green.
- **Phase 3 — OpenCode integration:** adapter extracting client/event-
  stream/session/prompt logic (port bridge.mjs listener + prompt logic into
  `integrations/opencode`), preserving protocol v2 semantics (session-reply
  capture, `[from/to]` routing, boss wake slice, lastPromptFrom map).
- **Phase 4 — Chat module migration:** message store/repository in new
  schema, message routing, fan-out send, prompt-to-boss, wake slice —
  equivalence with bridge behavior verified by tests against a COPY of
  realistic db data.
- **Phase 5 — Projects + Agents foundations:** domains with db tables,
  startup mirror from `agents.json`, API exposure. No CRUD UI.
- **Phase 6 — Frontend migration:** `web/` Next.js + shadcn/ui rebuild of
  the dashboard (sidebar views, chat feed, composer, theme) against the new
  backend APIs. Keep visual/behavioral parity with today's dashboard.
- **Phase 7 — Verification + review:** full gate run, independent Reviewer
  pass, fixes, then report to the Boss for acceptance. The Boss integrates.

Phases 3–6 are dispatched after each phase's report is accepted. Do not
stall between phases waiting for permission on ordinary technical decisions
— you have them — but DO report phase completion before starting the next.

## 6. Quality rules (binding)

- Strict TS; no `any` escape hatches without a comment justifying it.
- No business logic in route handlers or React components.
- Domain modules must not import Fastify or drizzle directly (infrastructure
  layer owns persistence).
- No OpenCode-specific logic outside `integrations/opencode`.
- Validation at every trust boundary (HTTP inputs, OpenCode events).
- Tests for every non-trivial unit (parsers, routing, transitions, SSE
  recovery). Existing store tests must keep passing at the repo root.
- Preserve behavior, not code: delete obsolete bridge code only at cutover
  (the Boss does the cutover).

## 7. Reporting

Report to the Boss after each phase: what shipped, gate results (commands +
output), deviations from this document (with reasons), open risks. Compact
messages; details in the dev worktree docs.
