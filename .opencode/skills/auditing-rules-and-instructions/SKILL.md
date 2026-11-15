---
name: auditing-rules-and-instructions
description: Use when verifying that a project actually passes its own rules and instructions — after a rule-heavy change session, before a release, when instruction files feel misaligned, or when asked to audit rules, memory, or behavior for staleness, duplication, or contradictions.
---

# Auditing Rules and Instructions

## Overview

Verify the project against its own rules. Core principle: **the skill teaches HOW to audit — it never freezes WHAT to audit.** The checklist is always derived from the rules and instructions as they exist at audit time. Read them first, then verify. A hardcoded checklist is the failure mode this skill exists to prevent (rules change; the audit must not go stale).

## When to Use / Not Use

- ✅ After a session that changed rules, memory, or instructions; before releases; on "does everything still pass our rules?"
- ❌ Normal code review (that's about the code, not the ruleset)
- ❌ Auditing with a remembered checklist — always derive it fresh

## The Method

```
1. INVENTORY     Enumerate every rule-bearing surface that exists NOW:
                 memory files, instruction files, agent definitions,
                 skills, templates, config. Nothing is assumed — list
                 what's actually on disk.
2. CRITERIA      Read the standing rules from memory. Every rule that
                 says "X must be Y" becomes a check.
3. REALITY       For each check: does the project actually match?
                 File exists where a decision says it does; wording
                 matches the decision; behavior matches the instruction.
4. CROSS-SURFACE The same fact stated in multiple places → all agree?
                 (Each surface has its own audience — consistency is
                 about substance, not identical wording.)
5. STALE         Pointers and references to things that no longer
                 exist (renamed files, retired mechanisms, old paths).
6. CONTRADICTION Instructions that conflict. The test: would an agent
                 have to guess which instruction wins? If yes — flag.
7. MAINTENANCE   Apply the maintenance rules that exist in memory at
                 audit time (circularity, necessity, consent, form,
                 classification…). Read them; don't hardcode them here.
8. REPORT        Pass / drift per check. Then per the memory-change
                 consent rule: mechanical syncs applied and reported,
                 substantive fixes proposed for the human's approval.
```

## Scope Discipline

- Respect the auditor's stated exclusions (e.g. machine-local workspaces)
- Session IDs, passwords, credentials are audit checks, not audit content — flag if they appear in committed files, never quote them into the report
- Audits change nothing silently: read-only by default except consent-rule mechanical syncs

## Common Mistakes

| Mistake | Reality |
|---|---|
| Auditing from memory of last time | The ruleset changed since; a stale checklist certifies the wrong thing |
| Reporting only drifts | A pass statement is evidence too — say what was checked and passed |
| Fixing substantive drift without the human | Consent rule: substantive memory changes are drafted-then-approved |
| Checking only the files that were touched | Drift lives in files nobody touched — sweep all surfaces |
