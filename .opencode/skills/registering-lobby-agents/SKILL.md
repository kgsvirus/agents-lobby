---
name: registering-lobby-agents
description: Use when a new OpenCode session must be created for a project and registered as a messageable agent in the Agents-Lobby registry (agents.json) — e.g. "add a new agent", "spawn a session for <project>", "register this session in the lobby".
---

# Registering Lobby Agents

Create an OpenCode session in a project directory, get its session ID, then register it in the Agents-Lobby registry so the bridge can message it.

## Steps (in order)

1. **Dedup check:** `GET /api/session?directory=<project dir>` (with auth, below). If a session already exists there, confirm with the human whether to reuse it before creating a new one.
2. **Create the session:**

   ```sh
   curl -X POST http://127.0.0.1:28894/api/session \
     -u "opencode:<password>" \
     -H "Content-Type: application/json" \
     -d "{\"title\": \"<title>\", \"location\": {\"directory\": \"<project dir>\"}}"
   ```

   - `location.directory` binds the session to the project — required.
   - Optional `agent` field pins an agent at creation. List valid IDs with `GET /api/agent`; project-specific agents come from that project's config. Omit to use the default.
   - The response's `data.id` (`ses_...`) is the session ID. It is returned immediately; no waiting.
3. **Ask the human for the registry name.** NEVER invent or propose-default-then-proceed: the name is the human's decision — ask, wait for the answer, use it verbatim.
4. **Register:** append to `F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby\agents.json` inside `agents`:

   ```json
   { "name": "<human's name>", "project": "<project name>", "session": "ses_..." }
   ```

   The bridge re-reads `agents.json` on every request — no restart needed.
5. **Report** to the human: the name, session ID, and project directory registered.

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

Registering an existing session the human already created → skip steps 1–2, start at step 3 with the known session ID.
