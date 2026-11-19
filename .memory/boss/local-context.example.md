# Local Context - Agents-Lobby (this machine)

> Purpose: machine-specific lobby deployment state - registered agents,
> project paths, per-project rulings and open items. This file is GITIGNORED
> (it describes only this machine); `setup.mjs` seeds it from
> `local-context.example.md` on new machines.
>
> Universal decisions live in `decision-log.md` (committed). The decision
> authority rule + escalation list: `decision-authority.md` (committed).
> Update this file after local changes: registrations, delegated rulings,
> machine sync state.
>
> Last updated: <fill in>

## Workstation layout

- Lobby repo: `<absolute path>`.
- Project workspaces: `<projects/ or another path>`. Record moves, re-bound
  sessions and worktree repairs here, with dates.

## Filesystem / toolchain (this machine)

- `<volume type and the build/link constraints it imposes; verified toolchain
  facts with the date they were verified>`

## Registry (this machine)

| Name | Project | Session |
|---|---|---|
| `<name>` | `<project>` | (see `agents.json` - gitignored; never duplicate session IDs here) |

Session IDs live in `agents.json` (gitignored) - never duplicate them here.

## Delegate rulings (on local projects, made as the human's delegate)

- `<project>: <ruling + context>`

## Local open items

- **L-O<nn>** `<item>` - `<status / decision needed>`
