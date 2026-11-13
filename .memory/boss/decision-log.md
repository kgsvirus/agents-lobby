# Decision Log — Agents-Lobby Boss

> Purpose: the approved decision record of the lobby system itself — universal
> across machines. This file is committed; new machines inherit the full
> decision history on clone. Machine-specific state lives in
> `local-context.md` (gitignored, seeded by `setup.mjs`).
>
> Dedup rule: if a would-be new decision duplicates an existing entry (same
> substance), do NOT create a duplicate — ask the human whether to update
> the existing entry, remove the new one, or change nothing. Only truly new
> decisions get new entries.
>
> Last updated: 2026-11-13 (v1.0.0 shipped).

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
- **Commit format:** `feat|fix (v1): <summary>`; commits only on explicit
  human approval; **push is human-only**. Releases: annotated tag after
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
- **D14** Synthetic echo removed: every path it covered is native now
  (webchat prompts arrive as prompts; boss sends visible as shell actions;
  `Human:` sends intentionally boss-invisible). — approved
- **D15** Routed copies (relaying with `[from: boss] [to: agent]` via
  `/webhook` so project views carry boss commentary) — **REMOVED by human
  decision**: relays live in the boss session context only (visible via the
  session mirror in Boss/All views); webchat `/webhook` routing reverted.
  Documented for humans in README "Message visibility". — removed
- **D16** Boss memory: decision log (this file) + `local-context.md`
  (machine state); boss `AGENTS.md` points to both. — approved (current)
- **D17** Decision authority rule (boss `AGENTS.md`): delegated work makes the
  boss the decision authority for that work; escalate only for
  scope-change/new-feature/irreversible/credentials-or-cross-project/
  beyond-authority decisions (judgment list, refined with the human; ask when
  unsure); delegated rulings logged in memory for human audit. — approved
- **D18** Reply routing (refines D13): agent replies log
  `[from: <name>] [to: <last prompter>]` (lastPromptFrom map, updated by
  /send; defaults to boss); boss-session replies log `[to: human]`.
  Historical log lines keep their original tags (append-only). — approved

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
