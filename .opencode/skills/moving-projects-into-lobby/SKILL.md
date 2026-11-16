---
name: moving-projects-into-lobby
description: Use when moving a project into or out of the lobby's gitignored projects/ workstation folder — symptoms include access-denied move failures with no visible lockholder, "dubious ownership" git errors after a move, worktree links showing "prunable" or "gitfile does not point to a valid repository", agent sessions bound to stale project paths, or hardcoded absolute paths breaking after relocation.
---

# Moving Projects Into the Lobby

## Overview

Move project folders into `Agents-Lobby\projects\` (gitignored — each project keeps its own git repo, no submodules) so the lobby is the one-place workstation. Core principles: **check before touching, repair both sides of every link, fix operational paths but leave history alone, re-bind sessions, keep the human's gates.**

## When to Use / Not Use

- ✅ Relocating any project into (or out of) `projects/`; consolidating a workstation
- ✅ After any manual folder move: broken worktrees, git ownership errors, orphaned agent sessions
- ❌ Cloning a fresh project straight into `projects/` (no move = no repair; still do Phase 4 + 5)
- ❌ Committing, pushing, or messaging agents without the human's explicit word (lobby gates)

## The Flow

```
INPUT: human names the project(s) and the destination (projects/ is
       created by setup.mjs; verify it exists + is gitignored first)
─────────────────────────────────────────────────────────────────────
PHASE 1 — PRE-FLIGHT (per project)
   a. git -C <project> status --short        → record dirty state (it
      travels with the folder; never commit without the human's word)
   b. git worktree list                       → linked worktrees must
      move TOGETHER with the main repo
   c. running processes referencing the project → none allowed
      (Get-CimInstance Win32_Process | command-line match)
   d. deep-scan backup option: git bundle create <backup> --all
─────────────────────────────────────────────────────────────────────
PHASE 2 — THE MOVE (same volume = rename, instant + lock-revealing)
   Move-Item -LiteralPath <old> -Destination <new>
   → Access denied? See ESCALATION LADDER below.
   → Cross-volume? robocopy /E /XJ, then delete originals AFTER
     verification (Phase 5).
─────────────────────────────────────────────────────────────────────
PHASE 3 — REPAIR
   a. safe.directory: git config --global --add safe.directory <new>
      (fixes "dubious ownership" on every moved repo + worktree)
   b. worktree pair:
      1. git worktree repair  (try from main repo, then from inside
         the worktree — the worktree side can find a moved main)
      2. STILL broken ("prunable" / "gitfile does not point to a
         valid repository")? Rewrite both pointers manually:
         - worktree\.git            → "gitdir: <new-main>/.git/worktrees/<name>"
         - <main>/.git/worktrees/<name>/gitdir → "<new-worktree>/.git"
      3. verify: git worktree list shows new paths, no "prunable"
      NEVER run `git worktree prune` during a move.
   c. OpenCode-managed worktrees under
      ~\.local\share\opencode\worktree\ may break — FLAG, don't touch.
─────────────────────────────────────────────────────────────────────
PHASE 4 — STATIC-PATH SWEEP (exclude node_modules, .git, caches)
   Search text files for old roots (F:\, E:\, old parent dirs):
   - FIX operational files: project AGENTS.md canonical paths,
     handoff STATE.md, .graphify_root, *.csproj.user / *.pubxml.user,
     tool configs
   - LEAVE historical records (reports, diffs, plans, session
     archives) — they document what was true then
   - LEAVE regenerating caches (.next, build output) — they rebuild
─────────────────────────────────────────────────────────────────────
PHASE 5 — LOBBY RE-WIRING
   a. Sessions: directory-bound → re-bind each agent session with
      session_move (keeps session ID + history; agents.json unchanged)
   b. Stale OpenCode worktree links under ~/.local/share → flag only
   c. Conventions: global AGENTS.md §8.1 + placeholder source must
      say where projects live; setup.mjs creates projects/
   d. Memory: local-context.md workstation-layout note (gitignored)
─────────────────────────────────────────────────────────────────────
PHASE 6 — VERIFY
   git worktree list / status per project · branch + dirty state
   match the Phase 1 snapshot · a live agent round-trip if re-bound
─────────────────────────────────────────────────────────────────────
GUARDRAILS
   • No commits, no pushes, no agent messages without the human's word
   • Dirty trees are FINE — uncommitted work moves with the folder
   • Never prune worktrees mid-move; never delete originals before
     Phase 6 verification passes
```

## Lock Escalation Ladder (Phase 2 access-denied)

Denied with **no visible holder** (command lines show nothing — silent handles: file watchers, language servers, the OpenCode server holding session dirs):

1. Identify precisely: Sysinternals `handle.exe` (`handle.exe -a <path>`) — shows pid + which handles
2. Safe kills first: orphaned `CodeAnalysis.LanguageServer.exe` etc. (respawn on demand)
3. Ask the human to close editors/Watchers; retry
4. Last resort: the OpenCode desktop app restart — **the human does it** (it hosts the boss session; sessions survive on disk; work is stateless — say "continue" after relaunch)
5. If still locked: the human moves the folder manually (the skill is resumable — every phase is idempotent)

## Common Mistakes

| Mistake | Reality |
|---|---|
| Moving only one side of a worktree | Link is absolute both ways — move the pair together, then repair |
| Skipping `safe.directory` | Every moved repo fails with "dubious ownership" |
| `git worktree prune` to "clean up" | Deletes the metadata that makes repair possible |
| Fixing paths in historical docs | They document the past; only operational files matter |
| Re-registering moved agents from scratch | `session_move` re-binds in place — history and IDs survive |
| Killing the OpenCode app to free locks yourself | It hosts the boss session — the human closes and resumes |
