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
2. `node setup.mjs` — creates `config/agents.json` from the template if missing, the
   gitignored `projects/` folder, and `.memory/boss/local-context.md` from its
   example when absent (existing files are never overwritten; your personal
   global `AGENTS.md` is never touched)
3. Fill real session IDs into `config/agents.json` (see `config/agents.example.json`)
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
| Peer send between two agents (`Peer <name>: …`) | ✗ (no wake) | ✅ | ✅ (involved agents) |
| Peer send addressed to Boss | ✅ | ✅ | ✗ |
| Agent reply addressed to the human | ✗ (no wake) | ✅ | ✅ (its project) |

**Rule of thumb:** Boss view = the boss↔human channel plus boss sends; project
and agent views = everything involving that project's agents; All = everything.
Unrouted boss commentary (status updates, relays) lives in the Boss/All
channel by design. The boss is WOKEN only by traffic addressed to `boss`;
peer-to-peer traffic and agents' replies to the human are visible in the UI but
wake nobody.

## Installation / setup procedure

Run this after cloning (in the repo folder):

```sh
npm install
node setup.mjs
```

`npm install` installs the `server/` and `web/` npm workspaces. `setup.mjs`
performs the mechanical parts of onboarding:

1. Checks prerequisites — Node >= 24 and the `opencode` CLI on PATH.
2. Creates `config/agents.json` from `config/agents.example.json` if missing (never
   overwrites an existing one).
3. Creates the gitignored `projects/` workstation folder.
4. Verifies the local OpenCode service is reachable.

It does **not** start the server, send messages, or touch anything outside
the lobby folder — including your personal global `AGENTS.md`, which is
never modified (lobby instructions live in this repo's own `AGENTS.md`).

**After setup:** fill real session IDs into `config/agents.json`, build the
dashboard (`npm run build -w web`), and start the server (see "Running").

**Syncing the Boss session:** after starting OpenCode, select the **Boss**
agent and prompt *"Sync your session in lobby config"* — it registers the
session you are in as the boss in `config/agents.json` automatically (the registry
hot-reloads; no restart needed).

**Migrating from the legacy architecture (pre-v1.3.0):** a `git pull` replaces
the legacy bridge with the modular `server/` + `web/` architecture. Your
registry (`config/agents.json`) and messages are preserved. Stop any still-running
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
for their human): dedup check, agent-file provisioning (copy the template; an
existing file is replaced, merged or backed up on the human's choice), session
creation titled `(<name>)<project>`, registry registration in
`config/agents.json`, and finally one identity message telling the agent its
registered name:

```jsonc
{ "name": "taskflow", "project": "TaskFlow", "session": "ses_..." }
```

The server hot-reloads the registry — no restart needed. Manual registration
(editing `config/agents.json` directly, shape above) still works for simple cases.

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
(`opencode service status`); `LOBBY_OPENCODE_SERVER_URL` or `config/agents.json`'s
`serverUrl` are fallbacks.

**Two different addresses - do not confuse them:**

| What | Address | Used by |
|---|---|---|
| The lobby itself (API + dashboard) | `http://127.0.0.1:3005` | agents sending messages, browsers |
| The OpenCode service (`opencode-cli serve`) | whatever `config/agents.json` `serverUrl` / `LOBBY_OPENCODE_SERVER_URL` says (e.g. `:28894`) | the lobby's own session integration |

`config/agents.json`'s `serverUrl` is the **OpenCode** fallback for the lobby - it is
not the lobby's address, and posting `/send` there returns 404/405.

Run it from the repo folder: config paths resolve relative to the process
working directory, so from the repo root the defaults land exactly where the
old bridge had them — `config/agents.json`, `projects/`, `.data/`. (Developer
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
| `LOBBY_REGISTRY_PATH` | `config/agents.json` | Registry, hot-reloaded per request |
| `LOBBY_UI_DIR` | `../web/out` | Dashboard export served at `/ui` |
| `LOBBY_PROJECTS_DIR` | `./projects` | Listed by the dashboard's Projects module |
| `LOBBY_BODY_LIMIT` | 1 MB | Max request body size |
| `LOBBY_OPENCODE_TIMEOUT_MS` | `30000` | Upstream request timeout |

Local-trusted auth: no login system. Optionally, create the gitignored file
`.data/server.auth.json` in the repo folder (its location is fixed relative to
the run directory — no override variable) with `{"authToken": "..."}` — when
present, ONLY the send endpoints (`/send`, `/prompt`) require that bearer
token; the live event stream (`/api/events`) and all reads stay open (an
EventSource cannot send the header). With a token set, the dashboard's Settings
takes that token (shared-token mode) and keeps it for the tab. With identities
configured (`.data/peer-auth.json`) the dashboard auto-connects as `human`
instead - no paste, a loopback `HttpOnly` session cookie. Absent both files =
open local access, as before.

Development (two processes): `npm run dev -w server` on :3006 plus
`npm run dev -w web` on :3000 (proxies API calls to :3006).

## Peer messaging (agent to agent)

Registered agents can message each other, Boss, or the human directly instead
of going through the Boss relay.

- **Policy:** `config/peer-to-peer-allowlist.json` maps a **role** to the roles
  it may address; the roles are `human`, `boss`, and whatever an agent carries
  in `config/agents.json` (on this machine: `coordinator` for greg/ruben/Dummy). The
  real file is machine-local (gitignored); the example is committed and copied
  by setup on first run.

  | Sender | May address |
  |---|---|
  | `human` | `boss`, `coordinator`, `developer` |
  | `boss` | `human`, `coordinator` |
  | `coordinator` | `human`, `boss` |
  | `developer` | `human`, `coordinator` |

  - An agent's role lives in `config/agents.json`: `{"name": "ruben", ..., "role":
    "coordinator"}`. Adding another coordinator needs no policy edit - the
    roster comes from the registry.
  - **An agent without a `role` is inert**: it can neither send nor be
    addressed as a peer (marvin/porty today). Seed it with a role when it
    should participate.
  - Addressing a **role** fans out: `to: "coordinator"` reaches every
    coordinator, one prompt each, one archived row naming them all.
  - A role may not address itself (`coordinator` -> `coordinator` is refused).
  - There is no wildcard; the role list is the whole policy.
  - **Agents must not edit these files themselves** (this one, `.data/peer-auth.json`
    or their own `role` in `config/agents.json`) - PROTOCOL.md makes it a standing rule,
    because a policy or token edit is privilege escalation. They ask you or the
    boss instead; you apply it.
- **Identities:** `.data/peer-auth.json` (gitignored, never generated by setup)
  maps bearer tokens to principals:
  `{"tokens": {"<token>": {"name": "ruben", "kind": "agent"}}}`. `kind` is
  `human`, `boss`, or `agent`; it must agree with the name - a `human`/`boss`
  principal must be named `human`/`boss`, and an `agent` principal may not use
  either name or any name with whitespace or a colon. With this file present,
  `/send` derives the sender from the token and rejects a body `from` that
  disagrees (403); with it absent the legacy open `from`-body mode stays in
  force.
- **Dashboard:** with identities configured (`.data/peer-auth.json`), Settings
  auto-connects this browser as `human` - no paste: the server mints a loopback
  `HttpOnly; SameSite=Strict` session cookie (`POST /api/connect`), and
  Disconnect is sticky for the tab. In shared-token mode (`server.auth.json`
  only) the token field stays, because that is the only browser path there. In
  open mode there is nothing to connect. `GET /api/auth-mode` tells the UI which
  of the three it is. Disconnect signs out this tab's UI; the session cookie is
  browser-wide, so another tab of the same browser can re-establish it.
- **Trust boundary:** agents run as the same OS user on this machine, so a
  deliberately malicious agent could read another agent's token. These tokens
  bind identity and give an audit trail; they are not isolation. The same
  applies to the browser session: it is "loopback = human" for this OS user,
  not a sandbox, and a multi-user machine would broaden it. The allowlist
  governs lobby traffic only: any session that can reach the OpenCode API can
  prompt another session directly, bypassing this policy. Use TLS and separate
  OS users/containers if the lobby is ever exposed or shared.
- **Delivery guarantees:** the message row is archived exactly once under its
  `messageId` (scoped to the sender, so retrying is safe and another agent
  cannot claim your key), and delivery to OpenCode is attempted once, then
  retried once at the next server start for rows still unconfirmed - so at
  most one duplicate prompt can occur if the process dies mid-delivery.
- **Replies are explicit:** a peer answers with a new `/send`. Turn text
  captured from a normal session reply appears in the chat history but does not
  start a turn for the peer, so no automatic agent-to-agent loop exists.
- **Only boss-addressed traffic wakes the boss.** Peer-to-peer messages and an
  agent's reply to the human are archived and shown live in the UI, but wake
  nobody - waking the boss for them would restore the relay cost this removes.
- **Known residuals:** manual typing straight into an agent's desktop session
  emits no lobby event (O02), so a reply to it can be attributed to the peer
  prompt that was pending at the time; a multi-segment turn suppresses only its
  first captured segment (later segments archive as extra rows - noise, never a
  lost reply); and a prompt that arrives while the send's own turn is still
  running can let that turn's transcript archive as a duplicate row. Both are
  chosen over the alternative of losing a real reply.

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
| `config/agents.json` | Live registry (gitignored - contains session IDs) |
| `config/agents.example.json` | Registry template (committed) |
| `.data/messages.db` | Runtime message store (gitignored) |
| `.data/server.auth.json` | Optional bearer token (gitignored) |
| `setup.mjs` | Post-clone onboarding (prerequisites, registry template, `projects/`) |
| `.memory/boss/decision-log.md` | Boss decision record (committed, universal) |
| `.memory/boss/local-context.md` | Machine-specific boss memory (gitignored) |
| `.memory/boss/local-context.example.md` | Local-memory template |
| `projects/` | Machine-local project workspaces (gitignored; created by setup) |
| `.memory/boss/decision-authority.md` | Decision-authority rule + escalation list (committed, public) |
| `.placeholder/agent/` | Agent templates: `scrum-master.md` (orchestrator for new projects), `coordinator.md` (the older orchestrator, for existing projects and re-registration), plus the peer briefs |
| `.opencode/skills/` | Lobby skills — see **Skills** below |
| `.archives/docs/PROJECT_ANALYSIS.md` | Pre-migration project analysis (human-authored input; local archive, gitignored) |
| `incoming_messages.txt` | Pre-db message log archive (gitignored) |

## Skills

Skills are lobby capabilities an agent session can invoke. They live in
`.opencode/skills/` and grow over time — categorize this list when it
exceeds ~5 entries.

| Skill | Purpose |
|---|---|
| `creating-lobby-projects` | Scaffold a new project: directory, `## Agents-Lobby` pointer, `opencode.json` default agent, orchestrator file |
| `registering-lobby-agents` | Register one agent session into the lobby (dedup check → name → provision → session → registry row → identity message → report) |
| `moving-projects-into-lobby` | Move a project into/out of the `projects/` workstation folder (lock escalation, worktree repair, static-path sweep, session re-bind) |

## Not (yet) supported

Delivery receipts, retries UI.
