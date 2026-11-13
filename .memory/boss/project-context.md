# Boss Project Memory — Agents-Lobby

> Purpose: the boss agent's decision log and project-state snapshot. Check this
> file whenever context is uncertain (after compaction, or in a new session)
> before answering from memory. Update it after every approved decision.
> Last updated: 2026-11-13 (v1.0.0 shipped).
>
> Dedup rule: if a would-be new decision duplicates an existing entry (same
> substance), do NOT create a duplicate — ask the human whether to update
> the existing entry, remove the new one, or change nothing. Only truly new
> decisions get new entries.

## System snapshot

- **Architecture:** hub-and-spoke. Boss agent (this session, project
  Agents-Lobby) ↔ project-head agents. Agents: `taskflow`, `immigapp`,
  `porty`, `greg`, `ruben` (TaskFlow has `taskflow`, `greg`, `ruben`).
  Registry: `agents.json` (gitignored, hot-reloaded by bridge).
- **Bridge** (`bridge.mjs`, port 3005, zero deps): `/webhook`, `/send` (fan-out,
  `from: human|boss`), `/prompt` (webchat → boss), `/ui` (React dashboard from
  `dist/`), `/api/messages`, `/api/agents`. Event-stream listener mirrors
  boss + agent sessions into `incoming_messages.txt`. Server URL auto-discovered
  (`opencode service status`); auth = Basic `opencode:<password>` from
  `~/.config/opencode/service.json` (never in git).
- **Protocol v2:** agents reply in their own sessions; the listener captures
  `text.ended` as `[from: <name>]` (registry-derived) and wakes the boss
  (coalesced via inbox check). No webhook replies. Webchat Boss-row/All-empty
  compose = prompt into the boss session. Agent/project-row compose = direct
  `Human:` send (bypasses boss by design).
- **Web UI** (React+Tailwind+Vite at repo root, `src/`, dashboard `/ui`):
  sidebar Boss → All → projects → agents; sender-based alignment (Human right,
  others left) with label above bubble; picker scoped per view; Boss view
  picker disabled + forced prompt; empty selection disables Send in
  project/agent views; Dark/Light theme (system default, persisted,
  WCAG AA contrast).
- **Commit format:** `feat|fix (v1): <summary>`; I commit only on explicit
  human approval; **push is human-only**. Releases: annotated tag after
  version bump. Current: v1.0.0 (tag local; human pushes).
- **Onboarding:** `node setup.mjs` (idempotent, heading-variant-matching
  global-AGENTS.md install); `registering-lobby-agents` skill for new agents
  (dedup → provision coordinator copy-if-absent + `default_agent` → name from
  human → session titled `(<name>)<project>` → register → report).

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
- **D05** Sending identity: human asks me to send → `from: "boss"` (`Boss:`);
  human explicitly claims sender → `from: "human"` (`Human:`); web UI
  agent/project-row sends are `Human:`. — approved
- **D06** Approval gate: I never message any agent without explicit human
  approval, by any channel. — approved (standing rule)
- **D07** Fan-out via `/send` through OpenCode prompt API (`delivery: queue`,
  non-blocking); no child `opencode run` processes. — approved
- **D08** Onboarding: `setup.mjs` creates `agents.json` from template
  (never overwrites), installs global section idempotently (matches
  `## Agent Lobby` heading variants; section text = `agents-md-section.md`,
  now under `.placeholder/`). — approved
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
  (address-based). — approved after bug fix
- **D12** Composer rules: Boss view picker disabled + submit forced to
  prompt; All view = all agents pre-selected, label `To: all projects`;
  project view full-default selection → label `To: <Project>`; agent view
  locked to that agent; empty selection disables Send (project/agent views).
  — approved
- **D13** Protocol v2: agents reply in-session; event stream captures
  `text.ended` → `[from: <name>]` + coalesced boss wake; webhook replies
  banned; `Reply sent.` rule deleted; README (human) / `PROTOCOL.md`
  (agent rules) split; §8.1 + coordinator template point to `PROTOCOL.md`.
  — approved; refresher ACKed by all four pre-v2 agents
- **D14** Synthetic echo removed: every path it covered is native now
  (webchat prompts arrive as prompts; boss sends visible as shell actions;
  `Human:` sends intentionally boss-invisible). — approved
- **D15** Routed copies (relaying with `[from: boss] [to: agent]` via
  `/webhook` so project views carry boss commentary) — **REMOVED by human
  decision**: relays live in the boss session context only (visible via the
  session mirror in Boss/All views); webchat `/webhook` routing reverted.
  Documented for humans in README "Message visibility". (O04 closed with
  this entry — its verification premise was removed along with D15.)
- **D16** This memory file (`.memory/boss/project-context.md`) is the boss's
  decision log; boss `AGENTS.md` points to it. — approved (current)
- **D17** Decision authority rule (boss `AGENTS.md`): delegated work makes the
  boss the decision authority for that work; escalate only for
  scope-change/new-feature/irreversible/credentials-or-cross-project/
  beyond-authority decisions (judgment list, refined with the human; ask when
  unsure); delegated rulings logged in this memory for human audit. — approved

## Open / pending items

- **O01** Database storage for messages (planned phase; log is a growing
  text file read fully per wake — the growth problem is real, ~700+ lines).
- **O02** Listener does NOT capture agent-session user inbox items (desktop
  typing into agent sessions is invisible in the log; only their replies are
  captured). Accepted v1 gap; extension = zero-token fix if wanted.
- **O03** Possible duplicate delivery in the prompt API (one send produced
  two `[from: human]` log lines once). Unconfirmed; watch.
- **O05** TaskFlow reconciliation doc fixes (stale HEAD hash `46660b3` →
  `52b1288`; gate-count mismatch 268/268 vs 281/281) — await human
  authorization; doc-only edits via ruben's developer.
- **O06** TaskFlow Kanban work delivered on `feature/kanban-board`
  (not merged/pushed — human decision); live-browser WCAG checklist
  outstanding (options: human runs checklist / accept static / Playwright).
- **O07** Boss `AGENTS.md` slimming to a `PROTOCOL.md` pointer — decision open.
- **O08** Agent-to-agent direct messaging — out of scope for v1.
- **O09** GitHub push flow is human-only; verify remote sync state at session
  start (rebase rewrote hashes once; tags can orphan — re-point after rebase).
- **O10** Per-project memory separation (human idea, noted 2026-11-13): as the
  boss of multiple projects, split this memory into per-project context files
  (e.g. `.memory/boss/<project>.md`) so agent-project logs don't bloat the
  core decision log over time. Improvement only — do not implement until the
  human calls for it.

## Rulings made as the human's delegate

- Kanban work order (human-authorized phase): ruben's question "keep table
  row details + filters in the column conversion?" → decided KEEP ALL
  (removal would violate the scope lock). Design + plan approved by me.
- Ruben's rulings accepted: zero-total-rows keeps legacy "No tasks match";
  pre-existing lint warning stays ledgered; `.superpowers/sdd/` evidence kept
  (project rules > skill cleanup step).
