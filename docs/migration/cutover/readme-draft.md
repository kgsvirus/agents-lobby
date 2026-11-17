# Cutover draft — README.md replacement sections

**Audience:** the human operating the lobby (per D13a audience split: README =
human ops; agent-protocol content lives in PROTOCOL.md and is NOT touched here).
**Purpose:** the sections of the canonical `F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby\README.md`
to replace when the new stack is integrated at cutover. The Boss applies these
edits; nothing in the canonical repo changes before cutover.
**Source of truth for every claim:** the implemented code in this worktree
(`server/`, `web/`, root `package.json`) and `server/README.md`.

---

## Section-by-section

### UNCHANGED (do not edit)

- **Intro paragraph** ("A communication hub…")
- **Features** — all bullets stay; the dashboard URL bullet stays as-is
  (`http://localhost:3005/ui` is the post-cutover URL too).
- **Message visibility** table + rule of thumb — behavior-identical (the chat
  module is a verbatim port of the store/routing semantics).
- **Registering a project head** — `agents.json` remains the registry and is
  still hot-reloaded (re-read per request); nothing changes.
- **For agents** — unchanged.
- **Skills** — unchanged.
- **Not (yet) supported** — unchanged.

### REPLACE: "Installation" (both the short and the full "Installation / setup procedure" sections)

```markdown
## Installation

Requires **Node 24+** and the `opencode` CLI on PATH.

After cloning (in the repo folder):

1. `npm install` (installs the `server/` and `web/` workspaces)
2. `node setup.mjs` — creates `agents.json` from the template if missing, the
   gitignored `projects/` folder, and `.memory/boss/local-context.md` from its
   example when absent (existing files are never overwritten; your personal
   global `AGENTS.md` is never touched)
3. Fill real session IDs into `agents.json` (see `agents.example.json`)
4. Build the dashboard: `npm run build -w web`

The message store is a SQLite database, auto-created on first start.
```

### REPLACE: "How it works" (diagram + the two bullets)

```markdown
## How it works

    project head ⟶event stream⟶ server (Fastify, :3005) ⟶ .data/messages.db (SQLite, Drizzle)
                                    ⟵⟶ dashboard /ui (Next.js static export) & boss wake (unread slice)
    boss ──/send──▶ server ──▶ OpenCode prompt API ──▶ project head session(s)
    human ──webchat (Boss row)──▶ /prompt ──▶ boss session
    human ──webchat (agent/project row)──▶ /send ──▶ project head (as Human:)

- Event-driven: agents are only woken when there is something to read.
- The backend is a modular Fastify + TypeScript server (`server/`); the
  dashboard is a static Next.js export served by the server at `/ui` (no
  separate web process in normal operation).
- Architecture details: `docs/migration/architecture.md`.
```

(DB filename: the server uses `LOBBY_DB_PATH`, default `.data/dev.db` for dev —
at cutover the canonical store stays `.data/messages.db`. Keep the README
saying `.data/messages.db` after cutover; the command below sets it.)

### REPLACE: "Running"

```markdown
## Running

    # from the repo folder — cwd matters (see below)
    $env:LOBBY_PORT='3005'; $env:LOBBY_DB_PATH='.data/messages.db'
    npx tsx server/src/server.ts     # serves the API and the dashboard on :3005

Open the dashboard: `http://localhost:3005/ui`

The server discovers the local OpenCode server URL at startup
(`opencode service status`); `LOBBY_OPENCODE_SERVER_URL` or `agents.json`'s
`serverUrl` are fallbacks.

Run it from the repo folder: config paths resolve relative to the process
working directory, so from the repo root the defaults land exactly where the
old bridge had them — `agents.json`, `projects/`, `.data/`. (Developer
alternative: `npm run dev -w server` runs inside `server/`, so its relative
paths — including the default `.data/dev.db` — resolve under `server/`; give
the path variables absolute values if you use that form.)

Configuration is environment-variable driven (all optional; defaults let a
fresh clone run):

| Variable | Default | Meaning |
|---|---|---|
| `LOBBY_PORT` | `3006` | Listen port (3006 = dev; 3005 = production) |
| `LOBBY_HOST` | `127.0.0.1` | Bind address. Override (e.g. `0.0.0.0`) if non-local machines need to reach the lobby |
| `LOBBY_DB_PATH` | `.data/dev.db` | SQLite file (auto-created, gitignored) |
| `LOBBY_REGISTRY_PATH` | `agents.json` | Registry, hot-reloaded per request |
| `LOBBY_UI_DIR` | `../web/out` | Dashboard export served at `/ui` |
| `LOBBY_PROJECTS_DIR` | `./projects` | Listed by the dashboard's Projects module |
| `LOBBY_BODY_LIMIT` | 1 MB | Max request body size |
| `LOBBY_OPENCODE_TIMEOUT_MS` | `30000` | Upstream request timeout |

Local-trusted auth: no login system. Optionally, create the gitignored file
`.data/server.auth.json` in the repo folder (its location is fixed relative to
the run directory - no override variable) with `{"authToken": "..."}` - when
present, ONLY the send endpoints (`/send`, `/prompt`) require that bearer
token; the live event stream (`/api/events`) and all reads stay open (an
EventSource cannot send the header). Limitation: with a token set, the
dashboard composer's send/prompt calls return 401 - the UI has no token entry
yet (same-host trusted-client UI; token-based UI auth is a post-cutover
follow-up). Absent file = open local access, as before.

Development (two processes): `npm run dev -w server` on :3006 plus
`npm run dev -w web` on :3000 (proxies API calls to :3006).
```

Note for the Boss: there is no dedicated production start script — `npx tsx
server/src/server.ts` (the same entry the workspace `dev` script runs, with
repo-root cwd) is the run form used here; running from `server/dist/` after
`build -w server` is supported by design (`database/client.ts` comment) but
**unverified**. A `start` script is a reasonable post-cutover follow-up.

### REPLACE: "Files" table

```markdown
## Files

| File | Purpose |
|---|---|
| `server/` | Backend: Fastify API, chat/agents/projects modules, OpenCode integration, SQLite via Drizzle (`docs/migration/architecture.md`) |
| `server/src/infrastructure/database/migrations/` | Schema migrations (applied automatically at server start) |
| `web/` | Dashboard source (Next.js App Router, static export) |
| `web/out/` | Built dashboard served at `/ui` (created by `npm run build -w web`) |
| `vitest.config.ts` | Test-runner scope (`server/test/` + `web/test/`; the legacy `test/*.mjs` suites stay on `node --test`) |
| `PROTOCOL.md` | Agent-facing rules (identity, replies, token economy) |
| `AGENTS.md` | Instruction hub for the lobby and its managed projects (D25) |
| `.opencode/agents/boss.md` | Boss-agent instructions (this project's sessions) |
| `agents.json` | Live registry (gitignored - contains session IDs) |
| `agents.example.json` | Registry template |
| `.data/messages.db` | Runtime message store (gitignored) |
| `.data/server.auth.json` | Optional bearer token (gitignored) |
| `setup.mjs` | Post-clone onboarding (prerequisites, registry template, `projects/`) |
| `.memory/…`, `.placeholder/…`, `projects/` | as before (unchanged) |

Removed at cutover: `bridge.mjs`, `store.mjs`, `local-projects.mjs`, `src/`,
`dist/`, `test/`, `vite.config.ts` (plus the legacy Vite `dev`/`build`/`preview`
scripts in `package.json`) — the legacy bridge and Vite dashboard, superseded
by `server/` + `web/`. (`vitest.config.ts` is NOT removed — it is the NEW
test-scoping config for the server/web suites.) Deletion is the Boss's
cutover step, not part of the doc edit.
```

---

### Deliberately NOT drafted

- Any agent-facing content (identity prefixes, reply capture, token economy) —
  PROTOCOL.md territory, `docs/migration/cutover/protocol-draft.md` covers it.
- Boss agent definition (`.opencode/agents/boss.md`) and `.memory/` — out of
  scope (mission rule 8).
