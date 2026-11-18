# Agents-Lobby

A communication hub for OpenCode agents across projects. The **boss agent**
(the Agents-Lobby session) talks to project-head agents; every project keeps
its own agents and sessions. One boss, many projects — the hub-and-spoke model
for cross-project work.

## Features

- **Web dashboard** at `http://localhost:3005/ui` — sidebar (Boss / All
  projects / projects → agents), messenger-style chat, recipient picker,
  Dark/Light theme (defaults to your system preference)
- **Identity model** — `Human:` messages carry direct human authority;
  `Boss:` messages are the boss agent acting on your behalf
- **Automatic reply capture** — agents just reply in their sessions; the
  server captures everything via the OpenCode event stream (no webhook
  replies, no duplication)
- **Fan-out** — one message to one project, several, or all agents
- **Event-driven** — agents wake only when there is something to read
  (trigger → read → action → idle); near-zero token overhead
- **Onboarding** — `node setup.mjs` after cloning installs prerequisites
  checks, the agent registry, and the `projects/` workstation folder
  (your personal global `AGENTS.md` is never touched — lobby
  instructions live in this repo)

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

Full setup details in the "Installation / setup procedure" section below.

## How it works

```
project head ⟶event stream⟶ server (Fastify, :3005) ⟶ .data/messages.db (SQLite, Drizzle)
                                ⟵⟶ dashboard /ui (Next.js static export) & boss wake (unread slice)
boss ──/send──▶ server ──▶ OpenCode prompt API ──▶ project head session(s)
human ──webchat (Boss row)──▶ /prompt ──▶ boss session
human ──webchat (agent/project row)──▶ /send ──▶ project head (as Human:)
```

- Event-driven: agents are only woken when there is something to read.
- The backend is a modular Fastify + TypeScript server (`server/`); the
  dashboard is a static Next.js export served by the server at `/ui` (no
  separate web process in normal operation).
- Architecture details: `docs/migration/architecture.md`.

## Message visibility

What appears in each dashboard view:

| Message | 👑 Boss | 🌐 All projects | 📁 Project / agent |
|---|---|---|---|
| Boss send to an agent (`Boss: …`) | ✅ | ✅ | ✅ (its project) |
| Agent reply | ✅ if replying to a `Boss:` prompt ✗ if replying to your direct send | ✅ | ✅ (its project) |
| Human prompt to the boss (webchat Boss row) | ✅ | ✅ | ✗ |
| Human direct send to an agent (`Human: …`) | ✗ | ✅ | ✅ (its project) |
| Boss commentary / relays (unrouted) | ✅ | ✅ | ✗ |

**Rule of thumb:** Boss view = the boss↔human channel plus boss sends; project
and agent views = everything involving that project's agents; All = everything.
Unrouted boss commentary (status updates, relays) lives in the Boss/All
channel by design.

## Installation / setup procedure

Run this after cloning (in the repo folder):

```sh
npm install
node setup.mjs
```

`npm install` installs the `server/` and `web/` npm workspaces. `setup.mjs`
performs the mechanical parts of onboarding:

1. Checks prerequisites — Node >= 24 and the `opencode` CLI on PATH.
2. Creates `agents.json` from `agents.example.json` if missing (never
   overwrites an existing one).
3. Creates the gitignored `projects/` workstation folder.
4. Verifies the local OpenCode service is reachable.

It does **not** start the server, send messages, or touch anything outside
the lobby folder — including your personal global `AGENTS.md`, which is
never modified (lobby instructions live in this repo's own `AGENTS.md`).

**After setup:** fill real session IDs into `agents.json`, build the
dashboard (`npm run build -w web`), and start the server (see "Running").

**Syncing the Boss session:** after starting OpenCode, select the **Boss**
agent and prompt *"Sync your session in lobby config"* — it registers the
session you are in as the boss in `agents.json` automatically (the registry
hot-reloads; no restart needed).

**Migrating from the legacy architecture (pre-v1.3.0):** a `git pull` replaces
the legacy bridge with the modular `server/` + `web/` architecture. Your
registry (`agents.json`) and messages are preserved. Stop any still-running
`node bridge.mjs` process (it survives the pull and holds port 3005), then run:

```sh
node setup.mjs --fix
```

It backs up `.data/messages.db` automatically, runs `npm install`, builds the
dashboard, and re-checks everything. The database migrates on the first
server start — see "Running" below to start it.

**Filesystem note:** `npm install` (workspace symlinks) and `next build` fail
on drives without symlink support (e.g. exFAT). On such a drive, install and
build in a clone on an NTFS drive and copy `node_modules` / `web\out` over —
this is how the reference deployment runs.

## Registering a project head

The `registering-lobby-agents` skill handles the full flow (agents can run it
for their human): dedup check, coordinator provisioning (template copy, or
append/align the Lobby section in an existing coordinator), one identity
message telling the agent its registered name, session creation titled
`(<name>)<project>`, and registry registration in `agents.json`:

```jsonc
{ "name": "taskflow", "project": "TaskFlow", "session": "ses_..." }
```

The server hot-reloads the registry — no restart needed. Manual registration
(editing `agents.json` directly, shape above) still works for simple cases.

## Running

```powershell
# from the repo folder — cwd matters (see below)
$env:LOBBY_PORT='3005'; $env:LOBBY_DB_PATH='.data/messages.db'
npx tsx server/src/server.ts     # serves the API and the dashboard on :3005
```

**One server at a time:** run only a single lobby server against a database.
A second instance pointed at the same `.data/messages.db` (e.g. a forgotten
dev server on :3006 started with the same `LOBBY_DB_PATH`) double-captures
OpenCode events and double-wakes the boss.

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
the run directory — no override variable) with `{"authToken": "..."}` — when
present, ONLY the send endpoints (`/send`, `/prompt`) require that bearer
token; the live event stream (`/api/events`) and all reads stay open (an
EventSource cannot send the header). Limitation: with a token set, the
dashboard composer's send/prompt calls return 401 — the UI has no token entry
yet (same-host trusted-client UI; token-based UI auth is a post-cutover
follow-up). Absent file = open local access, as before.

Development (two processes): `npm run dev -w server` on :3006 plus
`npm run dev -w web` on :3000 (proxies API calls to :3006).

## For agents

Participating agents follow the rules in **`PROTOCOL.md`** — identity
prefixes, reply handling, and the token economy. Read it once when your
session first engages with the lobby (the lobby `AGENTS.md` points here).

## Files

| File | Purpose |
|---|---|
| `server/` | Backend: Fastify API, chat/agents/projects modules, OpenCode integration, SQLite via Drizzle (`docs/migration/architecture.md`) |
| `server/src/infrastructure/database/migrations/` | Schema migrations (applied automatically at server start) |
| `web/` | Dashboard source (Next.js App Router, static export) |
| `web/out/` | Built dashboard served at `/ui` (created by `npm run build -w web`) |
| `vitest.config.ts` | Test-runner scope (`server/test/` + `web/test/`) |
| `PROTOCOL.md` | Agent-facing rules (identity, replies, token economy) |
| `AGENTS.md` | Instruction hub for the lobby and its managed projects (D25) |
| `.opencode/agents/boss.md` | Boss-agent instructions (this project's sessions) |
| `agents.json` | Live registry (gitignored - contains session IDs) |
| `agents.example.json` | Registry template |
| `.data/messages.db` | Runtime message store (gitignored) |
| `.data/server.auth.json` | Optional bearer token (gitignored) |
| `setup.mjs` | Post-clone onboarding (prerequisites, registry template, `projects/`) |
| `.memory/boss/decision-log.md` | Boss decision record (committed, universal) |
| `.memory/boss/local-context.md` | Machine-specific boss memory (gitignored) |
| `.memory/boss/local-context.example.md` | Local-memory template |
| `projects/` | Machine-local project workspaces (gitignored; created by setup) |
| `.memory/boss/decision-authority.md` | Decision-authority rule + escalation list (committed, public) |
| `.placeholder/agent/coordinator.md` | Project-head coordinator template |
| `.opencode/skills/` | Lobby skills — see **Skills** below |
| `.archives/docs/PROJECT_ANALYSIS.md` | Pre-migration project analysis (human-authored input; local archive, gitignored) |
| `incoming_messages.txt` | Pre-db message log archive (gitignored) |

## Skills

Skills are lobby capabilities an agent session can invoke. They live in
`.opencode/skills/` and grow over time — categorize this list when it
exceeds ~5 entries.

| Skill | Purpose |
|---|---|
| `registering-lobby-agents` | Register a project-head session into the lobby (dedup check → name → provision → register → report) |
| `moving-projects-into-lobby` | Move a project into/out of the `projects/` workstation folder (lock escalation, worktree repair, static-path sweep, session re-bind) |

## Not (yet) supported

Agent-to-agent direct messaging, delivery receipts, retries UI.
