# Maintenance Cycle Work Order

**Issued by:** Boss agent (human-granted authority, 2026-11-19: "you have the
authority. do all excluding 5 (L-O11). after closes move to amnesia" - the
amnesia move is the Boss's job at integration, not yours).
**Executor:** Coordinator (ruben) + Developer/Reviewer subagents.
**Status:** COMPLETE 2026-11-19 - all three tasks shipped; final gate green (see `docs/migration/architecture.md` and the decision log).

## 0. Assignment exclusivity

Your assignment is **exclusively Agents-Lobby** (plus the one TaskFlow doc
fix in Task 3, which is TaskFlow-internal bookkeeping). TaskFlow project
instructions do not govern Tasks 1-2.

## 1. Worktree

- **Dev worktree (yours):**
  `C:\Users\user\.local\share\opencode\worktree\07a179\lobby-maintenance`
  (branch `feat/maintenance`, node_modules pre-copied - do NOT run
  `npm install`; exFAT canonical cannot, and the copy is complete).
- **Canonical worktree:** `F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby` -
  READ-ONLY for you. Never modify, never commit there. The Boss integrates.
- **NO commits anywhere** - working-tree changes only; the Boss commits at
  integration.
- Discipline: same as the migration cycle - developer implements, fresh
  reviewer verifies, fix rounds until green, report with gate output
  (build 0, full vitest green, no commits, canonical untouched).

## 2. Tasks

### Task 1 - Wake/capture hardening (server)

**[ITEM 1.1 STRUCK — Boss ruling 2026-11-19, option (d): NO capture-guard.
Boss `text.ended` replies are captured unconditionally; the queued option-B
concept is obsolete (superseded by the relay-rule design). The guard added
this cycle was reverted; the inbox-side wake-prompt guard (Phase 4/bridge
parity) stays. Superseded open item closed — Boss archives at integration.
Scope below = items 2 and 3 only.]**

Three sub-items, each with red-green tests:

1. **Capture-guard verification/implementation:** verify the new listener's
   capture policy (Phase 4: boss-only filter, wake-echo suppression,
   `lastPromptFrom`) actually covers the retired bridge's option-B guard:
   boss `text.ended` replies are NOT captured when the last enqueued
   boss-inbox input was the wake prompt (not real human text). If the new
   listener lacks it, implement it with tests.
2. **Insert-dedup guard:** the capture path must not insert a duplicate row
   for the same OpenCode event (same `ts` + `sender` + `receiver` + `body`
   within a small window). Live evidence: rows 1461/1462 and 1463/1464 in
   the canonical db were 1-4 ms apart duplicates when two instances ran;
   the guard makes a mistaken second instance harmless. Red-green: a
   duplicate insert attempt is skipped and logged, not stored.
3. **Wake-window race fix:** the retired bridge advanced the bookmark after
   prompting, so two overlapping wake calls could deliver the same rows
   twice (the Nov-16 greg/porty duplicate). Choose and implement ONE:
   claim-at-read (bookmark advances when the slice is read, with
   prompt-failure rollback) or single-flight wake (in-flight marker + re-check
   after completion). Justify the choice in the report; tests must prove
   no-overlap and no-row-loss.

### Task 2 - Dual-mirror consolidation (server)

Drop the write-only `registry_mirror` table (migration `0001`): new additive
migration `0004` dropping it, remove its write/read code paths, update
tests. Verify first that nothing unique lives there (it is a projection of
`agents.json`; the `agents` table from `0002` is the consumed mirror).
Rationale: carried debt from Phase 5, human-approved consolidation.

### Task 3 - L-O05 TaskFlow reconciliation doc fixes (TaskFlow repo)

Doc-only edits in the TaskFlow repo
(`F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby\projects\TaskFlow`):
- stale HEAD hash `46660b3` -> the correct current hash (VERIFY against
  TaskFlow's actual git log first - do not trust the memory value)
- gate-count mismatch `268/268` vs `281/281` -> verify the real count and
  use it
These are TaskFlow's own reconciliation/handoff docs; fix only the stale
values, do not restructure. Committing in the TaskFlow repo is allowed for
this task (its own repo, human-authorized item) - but report the commit
hash; canonical stays untouched.

## 3. Gate + reporting

Full gate per task: `npm run build -w server` exit 0, `npx vitest run` green
(234 baseline + new tests), no canonical writes, no lobby-repo commits.
Report after each task or as one final report: what shipped, gate output,
deviations, open risks.
