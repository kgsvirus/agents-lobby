---
name: registering-lobby-agents
description: Use when a new OpenCode session must be created for a project and registered as a messageable agent in the Agents-Lobby registry (agents.json) — e.g. "add a new agent", "spawn a session for <project>", "register this session in the lobby".
---

# Registering Lobby Agents

Create an OpenCode session in a project directory, get its session ID, then register it in the Agents-Lobby registry so the bridge can message it.

## Steps (in order)

1. **Dedup check:** `GET /api/session?directory=<project dir>` (with auth, below). If a session already exists there, confirm with the human whether to reuse it before creating a new one.
   - **Reuse path:** skip step 4 entirely (the session already exists — no title). Still do step 2 (provisioning) and step 3 (ask the name), then register in step 5 with the existing session ID.
2. **Provision the coordinator agent in the project** (before or after session creation):
   - Copy the template at `<this skill's directory>/../../../.placeholder/agent/coordinator.md`
     to `<project dir>/.opencode/agents/coordinator.md` — **only if that file does not
     exist. If one exists, leave it untouched and report that.**
   - Ensure the project's `opencode.json` declares the coordinator as the default agent
     (`"default_agent": "coordinator"`):
     - no `opencode.json` in the project → create one:
       `{ "$schema": "https://opencode.ai/config.json", "default_agent": "coordinator" }`
     - exists without `default_agent` → add the field, preserving everything else
     - exists with a **different** `default_agent` → stop and ask the human; do not change it
3. **Ask the human for the registry name.** NEVER invent or propose-default-then-proceed: the name is the human's decision — ask, wait for the answer, use it verbatim. (It is needed before step 4: the session title embeds it.)
4. **Create the session:**

   ```sh
   curl -X POST http://127.0.0.1:28894/api/session \
     -u "opencode:<password>" \
     -H "Content-Type: application/json" \
     -d "{\"title\": \"(<name>)<project name>\", \"location\": {\"directory\": \"<project dir>\"}}"
   ```

   - **Title format is fixed: `(<name>)<project name>`** — e.g. `(taskflow2)TaskFlow` — using the name from step 3.
   - `location.directory` binds the session to the project — required.
   - Optional `agent` field pins an agent at creation (e.g. `"agent": "coordinator"` once provisioned). List valid IDs with `GET /api/agent`; project-specific agents come from that project's config. Omit to use the default.
   - The response's `data.id` (`ses_...`) is the session ID. It is returned immediately; no waiting.
5. **Register:** append to `F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby\agents.json` inside `agents`:

   ```json
   { "name": "<human's name>", "project": "<project name>", "session": "ses_..." }
   ```

   The bridge re-reads `agents.json` on every request — no restart needed.
6. **Report** to the human: the name, session ID, project directory, and whether the coordinator template was copied or already existed.

## Auth

The local OpenCode server requires HTTP Basic auth: username `opencode`, password = the `password` field in `~/.config/opencode/service.json`. Read it at runtime; never write it to files, logs, or git. Server URL comes from `opencode service status` (first line) — it changes on restart.

## Common Mistakes

| Mistake | Reality |
|---|---|
| Inventing the registry name | The name comes from the human, verbatim |
| 401 Unauthorized | Missing or wrong auth header — see Auth above |
| 404 on `/session/...` | Paths need the `/api` prefix: `/api/session`, not `/session` |
| Restarting the bridge after editing `agents.json` | Unnecessary — hot reload per request |
| Sending a first message to the new session | Requires the human's explicit approval (lobby rule) |

## When NOT to Use

Registering an existing session the human already created → same as the reuse path at step 1: skip the dedup question and step 4, still do provisioning (step 2) and ask the name (step 3), then register (step 5) with the known session ID.
