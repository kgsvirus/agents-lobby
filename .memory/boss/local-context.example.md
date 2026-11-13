# Local Context — Agents-Lobby (this machine)

> Purpose: machine-specific lobby deployment state — registered agents,
> project paths, per-project rulings and open items. This file is GITIGNORED
> (it describes only this machine); `setup.mjs` seeds it from
> `local-context.example.md` on new machines.
>
> Universal decisions live in `decision-log.md` (committed). Update this file
> after local changes: registrations, delegated rulings on local projects,
> machine sync state.
>
> Last updated: <fill in>

## Registry (this machine)

| Name | Project | Session |
|---|---|---|
| `<name>` | `<project>` | (see `agents.json` — gitignored; never duplicate session IDs here) |

## Known identity gaps / notes

- `<record any agent that learned its name by inference instead of instruction>`

## Delegate rulings (on local projects, made as the human's delegate)

- `<project>: <ruling + context>`

## Local open items

- **L-O<nn>** `<item>` — `<status / decision needed>`
