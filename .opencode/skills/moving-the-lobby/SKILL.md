---
name: moving-the-lobby
description: Use when the Agents-Lobby repo itself changes location or volume — moving it to another drive or folder, or afterwards when builds, agent sessions, or dev worktrees still resolve to the old root. Not for moving a project into projects/ (use moving-projects-into-lobby).
---

# Moving the Lobby Repo

## Overview

The lobby root, its `projects/` (nested git repos) and every registered session
move together. The shared mechanics — worktrees, `safe.directory`, the path
sweep, the lock ladder, the guardrails — live in `moving-projects-into-lobby`;
only the differences are here.

## When to Use / Not Use

- ✅ Moving the lobby repo to another drive or folder
- ✅ After such a move: a build, session or worktree still points at the old root
- ❌ Moving a project into `projects/` → `moving-projects-into-lobby`
- ❌ Committing, pushing, or messaging agents without the human's explicit word

## Before Anything

1. **The destination must be NTFS** —
   `Get-Volume -DriveLetter <X> | Select FileSystemType`. exFAT breaks
   `next build` (`readlink` returns `EISDIR` for a regular file), symlinks and
   npm workspace linking. Verify, never assume.
2. **Snapshot**: `git status --short`, `git -C projects/<p> status --short` per
   project, `git worktree list`, session IDs in `config/agents.json`.
3. **Stop the server** — nothing may hold `.data/` or `node_modules`.

## Move

Cross-volume: copy, then **keep the source** until verification passes. A
"move" that leaves the old tree behind is a fork risk — two live copies, edits
landing in the wrong one. Leave behind `node_modules`, `web/.next`, `web/out`,
`obj/`, `bin/`.

## Repair

Follow `moving-projects-into-lobby` phases 3–4, plus:

- per-repo `safe.directory` and path sweep, including each project;
- the OpenCode dev worktree breaks: rewrite
  `~\.local\share\opencode\worktree\<id>\<name>\.git` so its `gitdir:` names the
  **new** main repo. The other side
  (`<main>/.git/worktrees/<name>/gitdir`) names the worktree, so it needs no
  change. Never `worktree prune`;
- sweep operational files only — an asset that legitimately stayed on the old
  drive keeps its path.

## Re-bind Sessions

`session_move` every session that lived under the old root — **boss last**, it
is performing the move. `config/agents.json` holds session IDs, not paths: no
registry edit.

## Verify Before Deleting the Source

- `npm test`, `npm run build -w web` (regenerates the gitignored `web/out/`
  served at `/ui`)
- the server starts from the new root and `/ui` loads
- `git worktree list` clean; branch and dirty counts match the snapshot

## Common Mistakes

| Mistake | Reality |
|---|---|
| Choosing a drive for space, not filesystem | On exFAT builds, symlinks and workspace linking all fail |
| Treating a copy as a move | The old tree stays live; sessions and edits split |
| Re-binding the boss session first | It loses the directory it is working in |
| Re-registering the agents | `session_move` keeps session IDs and history |
| `worktree prune` to tidy up | Deletes the metadata repair depends on |
| Blanket-replacing the old drive letter | Breaks whatever legitimately stayed on that drive |

## Red Flags

- Destination volume never checked
- The old root still writable after the "move"
- A session or worktree still naming the old root
- Deleting the source before tests, build and `/ui` pass
