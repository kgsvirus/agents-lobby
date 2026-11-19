---
name: registering-lobby-agents
description: Use when a lobby-managed project needs agent sessions registered in `agents.json` - a new agent, a new project session, or a session the human already created.
---

# Registering Lobby Agents

Create an OpenCode session for **one agent** in a project directory (or reuse an
existing one) and register it in the Agents-Lobby registry so the server can
message it.

One agent = one session. A project with two agents (`dev`, `qa`) gets two
sessions, two passages through this skill, two `agents.json` rows - each session
pinned to its own agent file.

## Steps (per agent)

1. **Dedup check:** `GET /api/session?directory=<project dir>` (with auth,
   below), and compare with `config/agents.json`.
   - If a session for this agent already exists, confirm with the human:
     **reuse** it or **create new**.
     - **Reuse path:** skip session creation (step 5) - no title needed. Still
       do steps 2-4 and 6-8.
   - If none exist for it -> continue to step 2.
2. **Ask the human for the registry name.** NEVER invent or
   propose-default-then-proceed: the name is the human's decision - ask, wait
   for the answer, use it verbatim. It is the agent's lobby identity and is
   separate from the agent-file name (`dev` the file, `ruben` the identity).
3. **Provision the agent file:** `<project dir>/.opencode/agents/<agent-name>.md`
   from `.placeholder/agent/<agent-name>.md` in the lobby repo.
   - missing -> copy it verbatim.
   - exists -> **ask the human which to do**, with the file and what it holds:
     - **replace** - overwrite it with the template (project-specific content
       and any `model:` frontmatter are lost);
     - **merge** - keep every line the project already has, and append only
       the template's body sections that are missing; a section present with
       different text is reported, never overwritten. **Frontmatter is never
       touched**, so a hand-tuned `model:` survives;
     - **backup** - copy it to `<agent-name>.md.bak-YYYYMMDD-HHmmss` first
       (no colons: the stamp must be a valid file name), then replace.
     Never pick one yourself: the file may be hand-tuned, and a hand-tuned
     `model:` is the only thing model routing trusts.
4. **Project invariants** - `REQUIRED`: defined once, in
   `creating-lobby-projects` steps 3-5 (root `AGENTS.md` pointer, `opencode.json`
   default agent, and the orchestrator file that makes that default resolve).
   Apply all three exactly as written there, including every stop-and-ask case.
   Do not re-derive any of them from memory - read those steps, so the text and
   the values have exactly one home.
5. **Create the session:** `POST /api/session` with
   `{"title": "(<name>)<project name>", "location": {"directory": "<project dir>"}, "agent": "<agent-name>"}`
   - Title format is fixed: `(<name>)<project name>` - e.g. `(ruben)TaskFlow`.
   - `location.directory` binds the session to the project - required.
   - `agent` pins the session to the agent file from step 3. Never omit it:
     the project's `default_agent` is the orchestrator, not this peer.
   - The response's `data.id` (`ses_...`) is the session ID.
6. **Register:** in `<lobby repo root>/config/agents.json`, inside `agents` -
   **update the entry whose `session` matches, append only when there is none**.
   One session must never appear twice: a duplicate `name` makes that agent's
   every peer send fail with `409 ambiguous_sender`, and a duplicate session
   under a new name keeps attributing replies to the old one.

   ```json
   { "name": "<human's name>", "project": "<project name>", "session": "ses_...", "role": "<role if the human gave one>" }
   ```

   Omit `role` when the human did not name one - a role-less agent is inert
   (cannot send or be addressed). `human`, `boss` and `all` are reserved and
   rejected; a role must match `^[a-z][a-z0-9_-]*$` (lowercase, digits, `_`,
   `-`) - an invalid role makes every registry read fail, taking the whole
   lobby down. The server re-reads `agents.json` on every request - no restart.
7. **Identity message** - only now, when the session and the registry row both
   exist. It is the only message you may send to the session (authored by the
   human as part of running this skill), and it goes through the lobby's
   `/send` with your own principal token - not through the OpenCode service:
   - new session: `Agent Lobby: your session is registered; your name is <name>.`
   - reuse path: `Agent Lobby: your session is reused; your name now is <name>.`
   - **role-less agent:** `/send` cannot reach it (`403 no_role`). Do not work
     around it and do not invent a role: pause, report that the agent is
     unaddressable, and ask the human for a role (PROTOCOL.md, "A refused send
     stops the task").

8. **Report** to whoever delegated the task - the human, or the agent that
   invoked this skill: name, agent file, session ID, project directory, the
   file action (added / replaced / backed up + replaced / merged) and the
   project-invariant actions.

## Auth

The local OpenCode server requires HTTP Basic auth: username `opencode`,
password = the `password` field in `~/.config/opencode/service.json`. Read it
at runtime; never write it to files, logs, or git. Server URL comes from
`opencode service status` (first line) - it changes on restart.

## Common Mistakes

| Mistake | Reality |
|---|---|
| Inventing the registry name | Comes from the human, verbatim |
| One session for a project's several agents | One agent = one session; each pinned to its own file |
| Omitting `agent` on session creation | The session would open as the project's orchestrator |
| Choosing replace/merge/backup yourself | Existing file -> ask the human which; a hand-tuned `model:` is the only thing routing trusts |
| Recomputing the `AGENTS.md` pointer | It is fixed text; see `creating-lobby-projects` |
| Adding a `role` nobody asked for | Role is policy; a wrong role grants addressing rights |
| 401 Unauthorized | Missing or wrong auth - see Auth |
| 404 on `/session/...` | Paths need the `/api` prefix |
| Restarting the server after editing `agents.json` | Unnecessary - hot reload per request |
| Sending messages beyond the identity message | Requires the human's explicit approval |

## When NOT to Use

Registering a session the human already created -> the reuse path: skip the
dedup question and session creation; still do steps 2-4 and 6-8 with the known
session ID.
