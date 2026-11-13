---
name: registering-lobby-agents
description: Use when a new OpenCode session must be created for a project and registered as a messageable agent in the Agents-Lobby registry (agents.json) — e.g. "add a new agent", "spawn a session for <project>", "register this session in the lobby".
---

# Skill: registering-lobby-agents

# Registering Lobby Agents

Create an OpenCode session in a project directory (or reuse an existing one),
provision its coordinator agent, and register it in the Agents-Lobby registry
so the bridge can message it.

## Steps (in order)

1. **Dedup check:** `GET /api/session?directory=<project dir>` (with auth, below).
   - If sessions already exist there, confirm with the human: **reuse** one or
     **create new**.
     - **Reuse path:** skip the session creation (step 5) — no title needed.
       Still do step 2 (ask the name), step 3 (provisioning, including the
       identity message), step 5 (register with the existing session ID),
       step 6 (report).
   - If none exist → continue to step 3 (create new).

2. **Ask the human for the registry name.** NEVER invent or
   propose-default-then-proceed: the name is the human's decision — ask, wait
   for the answer, use it verbatim. (Needed early: provisioning, identity
   message, and the session title all embed it.)

3. **Provision the coordinator agent in the project:**
   - **No `coordinator.md` in the project** → copy the template at
     `<this skill's directory>/../../../.placeholder/agent/coordinator.md` to
     `<project dir>/.opencode/agents/coordinator.md`. The template carries the
     identity line ("You are registered as this project's `name` in the
     lobby's `agents.json`").
   - **`coordinator.md` EXISTS** (the project has its own instructions):
     - Detection (tolerant, not strict — humans may rename headings): find a
       section by **heading variant** (`## Agent Lobby`, `## Lobby
       communication`, etc.) **or** by content mentioning Agents-Lobby /
       `agents.json` / registered.
     - **No lobby section found** → append the template's **"## Lobby
       communication"** section (verbatim copy: identity, reply-in-session,
       no-webhook, PROTOCOL pointer).
     - **Section found but content differs from the template** → ALIGN:
       replace the section content with the template's copy (preserve the
       human's heading position/formatting; normalize non-standard headings
       to `## Lobby communication`).
     - **Section found and aligned** → leave untouched, report.
     - **PLUS the identity message** (the section copy is name-agnostic) —
       send the session one message:
       - new session: `Agent Lobby: your session is registered; your name is <name>.`
       - reuse path: `Agent Lobby: your session is reused; your name now is <name>.`
       This is the ONLY permitted first message to the session — authored by
       the human as part of running this skill.
   - **`opencode.json`:** missing → create
     `{ "$schema": "https://opencode.ai/config.json", "default_agent": "coordinator" }`;
     exists without `default_agent` → add the field, preserving everything
     else; exists with a **different** `default_agent` → STOP and ask the
     human; do not change it.

4. **Create the session:**

   ```sh
   curl -X POST http://127.0.0.1:28894/api/session \
     -u "opencode:<password>" \
     -H "Content-Type: application/json" \
     -d "{\"title\": \"(<name>)<project name>\", \"location\": {\"directory\": \"<project dir>\"}}"
   ```

   - **Title format is fixed: `(<name>)<project name>`** — e.g.
     `(taskflow2)TaskFlow` — using the name from step 2.
   - `location.directory` binds the session to the project — required.
   - Optional `agent` field pins an agent at creation (e.g.
     `"agent": "coordinator"` once provisioned). Omit to use the default.
   - The response's `data.id` (`ses_...`) is the session ID. Returned
     immediately; no waiting.

5. **Register:** append to
   `F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby\agents.json` inside `agents`:

   ```json
   { "name": "<human's name>", "project": "<project name>", "session": "ses_..." }
   ```

   The bridge re-reads `agents.json` on every request — no restart needed.

6. **Report** to the human: the name, session ID, project directory, the
   coordinator action taken (copied / appended / aligned / untouched), and the
   `opencode.json` action taken.

## Auth

The local OpenCode server requires HTTP Basic auth: username `opencode`,
password = the `password` field in `~/.config/opencode/service.json`. Read it
at runtime; never write it to files, logs, or git. Server URL comes from
`opencode service status` (first line) — it changes on restart.

## Common Mistakes

| Mistake | Reality |
|---|---|
| Inventing the registry name | The name comes from the human, verbatim |
| Strict heading match on existing coordinators | Detection is tolerant — heading variants or content mention count; non-standard headings get normalized |
| 401 Unauthorized | Missing or wrong auth header — see Auth above |
| 404 on `/session/...` | Paths need the `/api` prefix: `/api/session`, not `/session` |
| Restarting the bridge after editing `agents.json` | Unnecessary — hot reload per request |
| Sending any message beyond the registration identity message | Requires the human's explicit approval (lobby rule) |
| Editing a project's own coordinator content beyond the lobby section | Never — only the lobby section is appended/aligned |

## When NOT to Use

Registering an existing session the human already created → same as the reuse
path: skip the dedup question and session creation; still do provisioning
(step 3, including the identity message) and ask the name (step 2), then
register (step 5) with the known session ID.
