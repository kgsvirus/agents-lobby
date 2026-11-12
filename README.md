# Agents-Lobby

A communication hub for OpenCode agents across projects. The **boss agent**
(the Agents-Lobby session) sends messages to project-head agents; their replies
flow back through a webhook into `incoming_messages.txt`.

## How it works

```
project head ──webhook POST──▶ bridge (:3005) ──▶ incoming_messages.txt ──▶ boss (via prompt API)
boss ──POST /send──▶ bridge ──▶ OpenCode prompt API ──▶ project head session(s)
```

- Event-driven: agents are only woken when there is something to read. Idle otherwise.
- The bridge (`bridge.mjs`) is a single zero-dependency Node file.

## For project-head agents (receiving from the boss)

- **Identity:** if you receive a prompt starting with `Boss:`, it is from the
  Agents-Lobby boss agent. Prioritize it.
- **Reply:** send ALL your answers in ONE single batch POST to the webhook
  (never multiple messages — that floods the boss's inbox):

  ```
  curl -X POST http://localhost:3005/webhook -H "Content-Type: application/json" -d "{\"from\": \"<your-registered-name>\", \"message\": \"<all answers in one message>\"}"
  ```

- Your `from` name is the `name` registered for your project in `agents.json`
  (e.g. `taskflow`, `immigapp`). The boss uses it to attribute replies.
- **Token economy (mandatory):**
  - Answer from what you already know in the session. Do **not** re-verify Git,
    re-run builds/tests, or re-read docs to answer — only when the boss
    explicitly asks for verification. (Exception: when your own project's
    instructions mandate a check — e.g. Git is authoritative — they take
    precedence over lobby economy rules.)
  - Keep the webhook message short: a compact summary (aim ≤ ~10 lines).
    No logs, no file dumps, no step-by-step narration.
  - After the webhook POST succeeds, your visible session output is just one
    line: `Reply sent.` Do **not** restate the reply content, summarize it, or
    narrate what you did — the human reads replies on the boss/lobby side.

## For the boss agent (sending)

**Always get the human's approval before messaging any agent** — by any channel
(`/send`, `opencode run --session`, or anything else). The boss never contacts
project heads unprompted.

Fan out to 1, some, or all project heads via the bridge:

```sh
# one agent
curl -X POST http://localhost:3005/send -H "Content-Type: application/json" -d "{\"to\": \"taskflow\", \"message\": \"...\"}"

# several
curl -X POST http://localhost:3005/send -H "Content-Type: application/json" -d "{\"to\": [\"taskflow\", \"immigapp\"], \"message\": \"...\"}"

# all registered agents
curl -X POST http://localhost:3005/send -H "Content-Type: application/json" -d "{\"to\": \"all\", \"message\": \"...\"}"
```

The bridge prepends `Boss: ` automatically and delivers through OpenCode's
session prompt API with `"delivery": "queue"` (waits until the target session
is idle, then delivers — non-blocking).

## Webhook → boss wake-up

Inbound webhook messages are appended to `incoming_messages.txt` as
`[ISO-time] [from: <name>] <message>`, then the bridge wakes the boss session
via OpenCode's prompt API — but only if no wake prompt is already pending
(coalescing: one wake reads all accumulated lines in one batch).

## Installation / setup procedure

Run this after cloning (in the repo folder):

```sh
node setup.mjs
```

It performs the mechanical parts of onboarding:

1. Checks prerequisites — Node >= 18 and the `opencode` CLI on PATH.
2. Creates `agents.json` from `agents.example.json` if missing (never overwrites an existing one).
3. Installs the Agent Lobby rule (§8.1) into the user's global `AGENTS.md`
   (`~/.config/opencode/AGENTS.md`) — idempotent: skips when the
   `## 8.1 Agent Lobby` header is already present; creates the file if missing.
   The exact section text lives in `agents-md-section.md` (single source of truth).
4. Verifies the local OpenCode service is reachable.

It does **not** start the bridge, send messages, or touch anything beyond the
two config files and the global AGENTS.md.

**After setup:** fill real session IDs into `agents.json`, then start the
bridge with `node bridge.mjs`.

## Running

```sh
node bridge.mjs
```

The bridge discovers the local OpenCode server URL at startup (`opencode
service status`); `serverUrl` in `agents.json` is a fallback.

## Registering a project head

Edit `agents.json` (see `agents.example.json` for the shape):

```jsonc
{ "name": "taskflow", "project": "TaskFlow", "session": "ses_..." }
```

## Files

| File | Purpose |
|---|---|
| `bridge.mjs` | Webhook + fan-out bridge (zero deps) |
| `agents.json` | Live registry (gitignored — contains session IDs) |
| `agents.example.json` | Registry template |
| `incoming_messages.txt` | Runtime inbox (gitignored) |

## Not (yet) supported

Agent-to-agent direct messaging, per-agent inbox files, delivery receipts,
message history persistence.
