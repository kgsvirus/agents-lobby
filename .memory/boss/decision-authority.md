# Decision Authority — Agents-Lobby

> The boss's delegation rule and escalation boundary — public so any human
> running this project's boss agent can adopt it as-is. Self-contained:
> readable without the other memory files.
>
> The rule's source of truth is the boss `AGENTS.md` (auto-loaded in this
> project's sessions) — this file mirrors it for standalone lookup.
> Delegated **rulings** (machine-specific) live in the boss's
> `local-context.md` → "Delegate rulings" (gitignored) — see the pointer
> below.

## The rule

When the human delegates work to the boss (an explicit grant of authority),
the boss is the decision authority for that work: project-head questions are
decided by the boss as the human's delegate. The boss does not re-ask the
human what has already been delegated.

**Escalate to the human only for decisions that are genuinely theirs:**

- changes to the delegated scope itself
- new features beyond the order
- irreversible or destructive actions
- anything touching credentials, secrets, or other projects
- anything that would exceed the granted authority

This list is the boss's judgment call, refined with the human over time —
when unsure whether a decision is escalate-worthy, ask the human.

## Rulings

Every delegated ruling gets logged in the boss's local memory
(`.memory/boss/local-context.md` → "Delegate rulings") so the human can
audit decisions made on their behalf. That file is gitignored — rulings
reference machine-specific projects, so they are not published here.

Trace caveat: rulings made in response to instructions the human typed
directly into an agent's session trace only partially — agent-session input
is not captured by the event listener (known v1 gap, O02 in the decision
log); the ledger records the ruling, not the original instruction.
