# Decision Log — Agents-Lobby Boss

> Purpose: the approved decision record of the lobby system itself — universal
> across machines. This file is committed; new machines inherit the full
> decision history on clone. Machine-specific state lives in
> `local-context.md` (gitignored, seeded by `setup.mjs`).
>
> ## Vision
>
> Agents-Lobby is meant to grow into a **human assistant for everyday work** —
> the boss agent as the human's standing delegate across projects and daily
> tasks. Current refinements are steps toward that: every change should be
> judged against "does this move the lobby toward being the human's everyday
> assistant?"
>
> Dedup rule: if a would-be new decision duplicates an existing entry (same
> substance), do NOT create a duplicate — ask the human whether to update
> the existing entry, remove the new one, or change nothing. Only truly new
> decisions get new entries.
>
> Memory-maintenance rule: whenever memory is updated, always cross-check
> the other memory files (decision-log / local-context / behavior /
> decision-authority) for redundancy, content that can carry (move to its
> proper home), and alignment drift — proactively, without being asked.
> Flag anything found in the update report.
>
> Classification rule: when adding or moving memory content, verify
> whether it is **universal** (public → `decision-log.md`,
> `decision-authority.md`, `behavior.md` — committed) or
> **machine-specific** (personal → `local-context.md` — gitignored).
> Machine-specific content never enters committed files; universal content
> never hides in personal ones. When unsure, ask the human.
>
> Docs-sync rule: when making changes to memory, features, protocol,
> instructions, or behavior, always check `README.md` (human) and
> `PROTOCOL.md` (agents) — and the boss `AGENTS.md` — for content that
> needs updating or alignment per D13a. Proactively, without being asked;
> flag anything found in the update report.
>
> Last updated: 2026-11-14 (vision recorded).

## System snapshot (universal facts)

- **Architecture:** hub-and-spoke. Boss agent (Agents-Lobby project) ↔
  project-head agents, each project keeping its own agents/sessions.
- **Bridge** (`bridge.mjs`, port 3005, zero deps): `/webhook`, `/send`
  (fan-out, `from: human|boss`), `/prompt` (webchat → boss), `/ui`
  (React dashboard from `dist/`), `/api/messages`, `/api/agents`.
  Event-stream listener mirrors boss + agent sessions into
  `incoming_messages.txt`. Server URL auto-discovered
  (`opencode service status`); auth = Basic `opencode:<password>` from
  `~/.config/opencode/service.json` (never in git).
- **Protocol v2:** agents reply in their own sessions; the listener captures
  `text.ended` and wakes the boss (coalesced via inbox check). No webhook
  replies. Webchat Boss-row/All-empty compose = prompt into the boss session.
  Agent/project-row compose = direct `Human:` send (bypasses boss by design).
- **Web UI** (React+Tailwind+Vite at repo root, `src/`, dashboard `/ui`):
  sidebar Boss → All → projects → agents; sender-based alignment (Human
  right, others left) with label above bubble; picker scoped per view;
  Dark/Light theme (system default, persisted, WCAG AA contrast).
- **Commit format:** `feat|fix (v1): <summary>`; push is human-only; commit
  and send gates — see `behavior.md`. Releases: annotated tag after
  version bump.
- **Onboarding:** `node setup.mjs` (idempotent, heading-variant-matching
  global-AGENTS.md install); `registering-lobby-agents` skill for new agents.

## Decision log (approved)

- **D01** Hub-and-spoke topology; boss is the hub, each project keeps its own
  agents/sessions. — approved
- **D02** Address-based message log: tagged lines `[from: X] [to: Y]` in
  `incoming_messages.txt`; single inbox. — approved
- **D03** Token economy (mandatory): compact replies (~10 lines, no dumps),
  session-knowledge answers, no re-verification unless asked. Exception:
  project-mandated checks (e.g. Git-is-authoritative) take precedence. — approved
- **D04** Identity prefixes: `Boss:` = boss agent; `Human:` = human directly
  (direct human authority). — approved
- **D05** Sending identity: human asks the boss to send → `from: "boss"`
  (`Boss:`); human explicitly claims sender → `from: "human"` (`Human:`);
  web UI agent/project-row sends are `Human:`. — approved
- **D06** Approval gate: never message any agent without explicit human
  approval, by any channel. — approved (standing rule)
- **D07** Fan-out via `/send` through OpenCode prompt API (`delivery: queue`,
  non-blocking); no child `opencode run` processes. — approved
- **D08** Onboarding: `setup.mjs` creates `agents.json` from template
  (never overwrites), installs the global section idempotently (matches
  `## Agent Lobby` heading variants; section text = the
  `.placeholder/agents-md-section.md` source). — approved
- **D09** `registering-lobby-agents` skill: dedup check → provision
  coordinator (copy-if-absent; never overwrite; `opencode.json`
  `default_agent: coordinator` with conflict-ask) → registry name from human
  verbatim → session title `(<name>)<project>` → register → report. — approved
- **D10** Web UI stack: React + Tailwind + Vite at repo root (no subfolder),
  component-per-concern, data layer in `src/data/api.ts`; bridge serves
  `dist/` at `/ui` (base `/ui/`). — approved
- **D11** Visibility model: All = everything; Boss view = `[from: boss]` +
  `[to: boss]` only (human→agent direct sends excluded — they bypass the
  boss by design); project/agent views = traffic involving their agents
  (address-based). Documented for humans in README "Message visibility".
  — approved after bug fix
- **D12** Composer rules: Boss view picker disabled + submit forced to
  prompt; All view = all agents pre-selected, label `To: all projects`;
  project view full-default selection → label `To: <Project>`; agent view
  locked to that agent; empty selection disables Send (project/agent views).
  — approved
- **D13** Protocol v2: agents reply in-session; event stream captures
  `text.ended` + coalesced boss wake; webhook replies banned; `Reply sent.`
  rule deleted; README (human) / `PROTOCOL.md` (agent rules) split; §8.1 +
  coordinator template point to `PROTOCOL.md`. — approved; refresher ACKed
  by all pre-v2 agents
- **D13a** Documentation audience split (refines D13): one audience per
  document — `README.md` = human operations (about, features, installation,
  running, files); `PROTOCOL.md` = project-head agent rules (identity,
  replies, token economy); boss `AGENTS.md` = boss behavior only (wake
  trigger, sending identity, decision authority, relay rule, memory
  pointers). Boss-facing content does not live in `PROTOCOL.md` (slimmed to
  a reference note), and agent-facing content does not live in `README.md`.
  New docs must declare their audience before being written. — approved
- **D14** Synthetic echo removed: every path it covered is native now
  (webchat prompts arrive as prompts; boss sends visible as shell actions;
  `Human:` sends intentionally boss-invisible). — approved
- **D15** Routed copies (relaying with `[from: boss] [to: agent]` via
  `/webhook` so project views carry boss commentary) — **REMOVED by human
  decision**: relays live in the boss session context only (visible via the
  session mirror in Boss/All views); webchat `/webhook` routing reverted.
  Documented for humans in README "Message visibility". — removed
- **D16** Boss memory (under `.memory/boss/` in this repo): **`decision-log.md`**
  (committed — universal decision record), **`local-context.md`** (gitignored
  — machine state: registry, delegate rulings, local open items; seeded from
  `local-context.example.md`), **`decision-authority.md`** (committed —
  public mirror of the decision-authority rule + escalation list; machine
  rulings live in local-context), and **`behavior.md`** (committed —
  behavior gates + corrections log). Boss `AGENTS.md` points to all four.
  — approved (current, D20/D21)
- **D20** Public decision-authority file (`.memory/boss/decision-authority.md`):
  the delegation rule + escalation list, published for any human running
  this boss agent; machine-specific rulings stay in `local-context.md`
  (gitignored) — published file carries the rule, not other humans'
  project rulings. — approved
- **D21** Behavior memory (`.memory/boss/behavior.md`, committed): the
  behavior gates (exploratory = proposal; ambiguous gets clarified;
  draft-first; commit gate; send gate) + corrections log of the incidents
  that produced them. Boss `AGENTS.md` carries the condensed gates
  always-in-context. — approved
- **D17** Decision authority rule (boss `AGENTS.md`): delegated work makes the
  boss the decision authority for that work; escalate only for
  scope-change/new-feature/irreversible/credentials-or-cross-project/
  beyond-authority decisions (judgment list, refined with the human; ask when
  unsure); delegated rulings logged in memory for human audit. — approved
- **D18** Reply routing (refines D13): agent replies log
  `[from: <name>] [to: <last prompter>]` (lastPromptFrom map, updated by
  /send; defaults to boss); boss-session replies log `[to: human]`.
  Historical log lines keep their original tags (append-only). — approved
- **D19** Registration flow v2 + template identity line (restores D09's name
  gap): the coordinator template carries the identity line ("You are
  registered as this project's `name` in the lobby's `agents.json`"); the
  registering skill handles existing-coordinator projects via tolerant
  detection (heading variant or content mention) with three cases — append
  the template's Lobby communication section, align a differing section to
  the template copy, or leave aligned sections untouched — plus one identity
  message (name embedded) as the only permitted first message; reuse path
  includes the reuse/name message. The v2 rewrite had dropped the name line
  (unlogged then; that gap caused `ruben` to infer its name; its project used
  its own coordinator.md so no template copy reached it). Identity tell sent
  to ruben; TaskFlow's existing coordinator.md got the lobby section
  appended. — approved

## Open items (system-level)

- **O01** Database storage for messages (planned phase; the log is a growing
  text file read fully per wake).
- **O02** Listener does NOT capture agent-session user inbox items (desktop
  typing into agent sessions is invisible in the log; only their replies are
  captured). Accepted v1 gap; extension = zero-token fix if wanted.
- **O03** Possible duplicate delivery in the prompt API (one send produced
  two log lines once). Unconfirmed; watch.
- **O07** Boss `AGENTS.md` slimming to a `PROTOCOL.md`/decision-log pointer —
  decision open.
- **O08** Agent-to-agent direct messaging — out of scope for v1.
- **O10** Per-project memory separation (human idea): split machine memories
  into per-project files as deployments grow. Noted; not called for yet.
