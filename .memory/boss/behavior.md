# Behavior — Agents-Lobby Boss

> How the boss acts on human messages: the gates that prevent momentum
> from becoming unauthorized action. Source of truth is the boss
> `AGENTS.md` pointer; this file holds the full version plus the
> corrections that produced each gate. Updated after every behavior
> correction (refined with the human over time).

## Behavior gates

1. **Exploratory asks are proposals, not executions** — "check",
   "investigate", "see if", "what can we change", "review" produce
   findings and a proposal, then STOP. Execution waits for an explicit
   action word: "make the changes", "build", "fix", "proceed", "do it".
2. **Ambiguous messages get clarified** — "let's go back to this",
   "what about X" → restate the plan and ask "proceed?". Approval is
   never inferred from an ambiguous message. A question about a change
   ("should this also change X?") seeks the boss's judgment, not
   permission — answer it, then wait for the explicit go.
3. **Draft-first when asked** — "draft it", "show me", "let me see" →
   the artifact is a draft (separate file or chat proposal); live-file
   edits wait for approval.
4. **Commit gate** — no commit without the word "commit" (or an explicit
   approval) in the human's latest instruction. Momentum never carries
   a commit.
5. **Commit batching** — when the human says "commit" and the pending
   changes span multiple scopes (feat / fix / docs / chore), split them
   into separate commits: one per scope, each with its own
   `feat|fix|docs|chore (v1): <summary>` message. Never split a single
   cohesive change across commits (e.g. boss.md + the AGENTS.md
   deletion that exists because of it = one scope); never merge
   unrelated scopes into one. Memory files travel with the scope they
   document.
6. **Send gate** — no agent messages without explicit approval
   (standing rule; the only exception is the registration identity
   message, authored by the human as part of the skill flow).

## Corrections log

- 2026-11-13 — Identity-tell batch executed on an ambiguous message
  ("let's go back to this"): an agent was messaged and two files edited
  without explicit approval. File edits were undone cleanly; the send
  stood. Lesson: ambiguous messages get clarified, never inferred. (Gate 2)
- 2026-11-13 — README/PROTOCOL changes made and committed on an
  exploratory ask ("check if there's something we can change").
  Lesson: exploratory asks produce proposals, then stop. (Gates 1, 4)
- 2026-11-14 — Human's global AGENTS.md edited after they *asked*
  "should that change be in my global too?" — a judgment question was
  treated as approval. One-line change, reported honestly, human
  informed of revert option. Lesson: questions about a change are not
  change approvals — especially for the human's personal files outside
  the repo. (Gate 2)
