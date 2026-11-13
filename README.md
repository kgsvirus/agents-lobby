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
  bridge captures everything via the OpenCode event stream (no webhook
  replies, no duplication)
- **Fan-out** — one message to one project, several, or all agents
- **Event-driven** — agents wake only when there is something to read
  (trigger → read → action → idle); near-zero token overhead
- **Onboarding** — `node setup.mjs` after cloning installs prerequisites
  checks, the agent registry, and the global lobby rule

## Installation

After cloning (in the repo folder):

```sh
node setup.mjs
```

Then:

1. Fill real session IDs into `agents.json` (see `agents.example.json`)
2. Start the bridge: `node bridge.mjs`
3. Open the dashboard: `http://localhost:3005/ui`

Full setup details in the "Installation / setup procedure" section below.

## How it works

```
project head ──event stream──▶ bridge (:3005) ──▶ incoming_messages.txt ──▶ boss
boss ──/send──▶ bridge ──▶ OpenCode prompt API ──▶ project head session(s)
human ──webchat (Boss row)──▶ /prompt ──▶ boss session
human ──webchat (agent/project row)──▶ /send ──▶ project head (as Human:)
```

- Event-driven: agents are only woken when there is something to read.
- The bridge (`bridge.mjs`) is a single zero-dependency Node file.

## Message visibility

What appears in each dashboard view:

| Message | 👑 Boss | 🌐 All projects | 📁 Project / agent |
|---|---|---|---|
| Boss send to an agent (`Boss: …`) | ✅ | ✅ | ✅ (its project) |
| Agent reply (captured in-session) | ✗ | ✅ | ✅ (its project) |
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
node setup.mjs
```

It performs the mechanical parts of onboarding:

1. Checks prerequisites — Node >= 18 and the `opencode` CLI on PATH.
2. Creates `agents.json` from `agents.example.json` if missing (never
   overwrites an existing one).
3. Installs the Agent Lobby rule into the user's global `AGENTS.md`
   (`~/.config/opencode/AGENTS.md`) — idempotent: skips when a
   `## Agent Lobby` heading variant is already present; creates the file if
   missing. The exact section text lives in `agents-md-section.md`
   (single source of truth).
4. Verifies the local OpenCode service is reachable.

It does **not** start the bridge, send messages, or touch anything beyond the
two config files and the global AGENTS.md.

**After setup:** fill real session IDs into `agents.json`, then start the
bridge with `node bridge.mjs`.

## Registering a project head

Edit `agents.json` (see `agents.example.json` for the shape):

```jsonc
{ "name": "taskflow", "project": "TaskFlow", "session": "ses_..." }
```

The bridge hot-reloads the registry — no restart needed. Agents can do this
for their human via the `registering-lobby-agents` skill.

## Running

```sh
node bridge.mjs
```

The bridge discovers the local OpenCode server URL at startup
(`opencode service status`); `serverUrl` in `agents.json` is a fallback.

## For agents

Participating agents follow the rules in **`PROTOCOL.md`** — identity
prefixes, reply handling, and the token economy. Read it once when your
session first engages with the lobby (the global `AGENTS.md` Agent Lobby
section points here).

## Files

| File | Purpose |
|---|---|
| `bridge.mjs` | Webhook + fan-out + event-listener bridge (zero deps) |
| `agents.json` | Live registry (gitignored — contains session IDs) |
| `agents.example.json` | Registry template |
| `incoming_messages.txt` | Runtime message log (gitignored) |
| `.placeholder/agents-md-section.md` | Exact global-AGENTS.md section text |
| `.placeholder/agent/coordinator.md` | Project-head coordinator template |
| `.opencode/skills/registering-lobby-agents/` | Session registration skill |

## Not (yet) supported

Agent-to-agent direct messaging, message history in a database (the log is a
growing text file), delivery receipts, retries UI.
