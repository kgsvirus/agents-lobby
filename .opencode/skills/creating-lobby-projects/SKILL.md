---
name: creating-lobby-projects
description: Use when the human says to create a new project in the Agents-Lobby (a new project directory) - including when they name its agents in the same breath.
---

# Creating Lobby Projects

## Overview

"Create a project" means **one directory plus three lobby invariants**. Agents,
sessions and registry rows are a separate act (`registering-lobby-agents`) and
are never part of scaffolding.

## Steps

1. **Ask for the project name.** Use it verbatim as the directory name; never
   invent or "sensible-default" it. It is created at
   `<lobby root>/projects/<Name>`. If the human wants it anywhere else, stop
   and say so: the pointer below is fixed to the standard layout.
2. **If the directory already exists**, do not scaffold it: say so, then apply
   steps 3-5 to it as repairs (each step has its own existing/absent rules).
   Otherwise create it.
3. **Root `AGENTS.md`** - ensure this section EXACTLY, heading and text on
   consecutive lines with no blank line between them:

   ```markdown
   ## Agents-Lobby
   You are a lobby-managed project. Before any work in this project, read ..\..\AGENTS.md (the lobby's instruction hub) and follow it.
   ```

   File missing -> create it with just this section. Section present and
   matching -> leave it. Section absent -> append it. Section present but
   differing -> replace that section only, preserving every other section.
   The section runs from its `## Agents-Lobby` heading to the next `## `
   heading or end of file - never past that boundary. If the file carries more
   than one such section, keep the first and delete the rest, so the project
   ends with exactly one.
4. **`opencode.json`** - missing -> create
   `{ "$schema": "https://opencode.ai/config.json", "default_agent": "scrum-master" }`;
   exists without `default_agent` -> add `scrum-master`, preserving everything
   else; exists with a **different** `default_agent` -> **STOP and ask the
   human**; do not change it; unparseable or unreadable JSON -> **STOP and ask**,
   never rewrite a config you cannot parse.
5. **Provision the orchestrator:** copy `.placeholder/agent/scrum-master.md` to
   `<project dir>/.opencode/agents/scrum-master.md`. This is what makes the
   `default_agent` in step 4 resolve to a real file. If it already exists, ask
   the human: **replace**, **merge** (exactly as defined in
   `registering-lobby-agents` step 3 - project text kept, frontmatter never
   touched, only missing body sections added), or **backup**
   (`.bak-YYYYMMDD-HHmmss` beside it, then replace). Never choose for them.
6. **Report** to whoever delegated the task - the human, or the agent that
   invoked this skill - then either stop or hand off: directory, `AGENTS.md`
   action (created / appended / replaced / verified), `opencode.json` action,
   `scrum-master.md` action (added / replaced / backed up + replaced / merged).
   If the human named agents in the same request
   ("2 agents: developer, qa-reviewer"), hand off to `registering-lobby-agents` -
   one session per agent. Do not provision those peer files or any session
   yourself.

## Never create here

`README.md`, a git repo, source scaffolding, `docs/` trees, any agent `.md`
other than `scrum-master.md`, registry rows, allowlist or token edits. The
human asked for a project, not for your idea of one. Ask if any of these are
wanted.

## Common Mistakes

| Mistake | Reality |
|---|---|
| Recomputing or rewording the pointer | The section is fixed verbatim - `..\..\AGENTS.md` |
| Copying a peer agent into the new project | Only `scrum-master.md` is scaffolded; peers come from registration, one session each |
| Overwriting an existing orchestrator file unasked | Ask: replace / merge / backup |
| Writing `default_agent: "coordinator"` | `scrum-master` is the default; a different existing value stops and asks |
| Inventing a `README.md` | Unrequested content the project then has to live down |
| Creating a session or an `agents.json` row | That is `registering-lobby-agents`; there is no session id yet |
| Guessing the project name | Asked, verbatim, always |

## Red Flags

- A file in the new project that the human did not name and no invariant requires
- An agent file other than `scrum-master.md`, a `ses_...` id, or a registry entry created before registration
- The `## Agents-Lobby` section written with anything other than the exact text above
