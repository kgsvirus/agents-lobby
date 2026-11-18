# Decision Log â€” Agents-Lobby Boss

> Purpose: the approved decision record of the lobby system itself â€” universal
> across machines. This file is committed; new machines inherit the full
> decision history on clone. Machine-specific state lives in
> `local-context.md` (gitignored, seeded by `setup.mjs`).
>
> ## Vision
>
> Agents-Lobby is meant to grow into a **human assistant for everyday work** â€”
> the boss agent as the human's standing delegate across projects and daily
> tasks. Current refinements are steps toward that: every change should be
> judged against "does this move the lobby toward being the human's everyday
> assistant?"
>
> Dedup rule: if a would-be new decision duplicates an existing entry (same
> substance), do NOT create a duplicate â€” ask the human whether to update
> the existing entry, remove the new one, or change nothing. Only truly new
> decisions get new entries.
>
> Memory-maintenance rule: whenever memory is updated, always cross-check
> the other memory files (decision-log / local-context / behavior /
> decision-authority) for redundancy, content that can carry (move to its
> proper home), and alignment drift â€” including form: a rule set should
> read as one system (parallel labels, consistent structure), not seven
> individual drafts. Proactively, without being asked. Flag anything
> found in the update report. Removed decisions are archived to
> `amnesia.md` (gitignored), not deleted.
>
> Classification rule: when adding or moving memory content, verify
> whether it is **universal** (public â†’ `decision-log.md`,
> `decision-authority.md`, `behavior.md` â€” committed) or
> **machine-specific** (personal â†’ `local-context.md` â€” gitignored).
> Machine-specific content never enters committed files; universal content
> never hides in personal ones. When unsure, ask the human.
>
> Docs-sync rule: when making changes to memory, features, protocol,
> instructions, or behavior, always check `README.md` (human) and
> `PROTOCOL.md` (agents) â€” and the boss `AGENTS.md` â€” for content that
> needs updating or alignment per D13a. Proactively, without being asked;
> flag anything found in the update report.
>
> Circularity rule: when checking memory (and instructions), also look
> for circular instructions/rules â€” rules that reference each other in a
> loop, exist only to serve each other, or whose revision would
> invalidate one another. Flag such loops to the human with a proposed
> cut (which rule to revise or remove). Healthy pointer chains are fine:
> each hop must carry unique substance and the chain must terminate on
> real content. The purpose is unambiguous instruction-following: any
> agent (or the boss) hitting these rules must never have to guess which
> instruction wins.
>
> Necessity rule: when checking memory, also ask of each entry: "would
> the project still progress without this knowledge?" If yes, the entry
> is history, not substance â€” propose trimming it to its protective
> minimum (the part that guards against re-litigating a settled
> decision) or removing it. Records whose only job is "why we don't do
> X again" survive in one line, not a narrative.
>
> Memory-change consent rule: removing memory (moving it to `amnesia.md`)
> always asks the human first â€” removal is never autonomous. Substantive
> memory changes (new rules, revised rules, new decisions) are drafted in
> chat and applied only on approval. The exception is mechanical
> status-sync â€” marking items closed after the human's instruction,
> syncing wording to already-approved decisions â€” which is applied
> proactively per the memory-maintenance rule and reported in the update.
>
> Last updated: 2026-11-18 (D26 architectural migration + snapshot sync).

## System snapshot (universal facts)

- **Architecture:** hub-and-spoke. Boss agent (Agents-Lobby project) â†”
  project-head agents, each project keeping its own agents/sessions.
- **Server** (`server/`, Fastify + TypeScript, port 3005 in production):
  modular monolith â€” chat/agents/projects modules, OpenCode integration
  isolated in `integrations/opencode`, SQLite via Drizzle
  (`.data/messages.db`, migrations applied at startup), internal event bus
  + SSE `/api/events`. Endpoints: `/send` (fan-out, `from: human|boss`),
  `/prompt` (webchat â†’ boss), `/webhook` (backward-compat), `/ui`
  (dashboard), `/api/messages`, `/api/agents`. OpenCode server URL
  auto-discovered (`opencode service status`); auth = Basic
  `opencode:<password>` from `~/.config/opencode/service.json` (never in
  git).
- **Protocol v2 (substance unchanged):** agents reply in their own
  sessions; the event-stream listener captures `text.ended` and wakes the
  boss (coalesced). No webhook replies. Webchat Boss-row/All-empty compose
  = prompt into the boss session. Agent/project-row compose = direct
  `Human:` send (bypasses boss by design).
- **Web UI** (`web/`, Next.js + Tailwind + shadcn/ui, static export at
  `/ui`): sidebar Boss â†’ All â†’ projects â†’ agents; sender-based alignment
  (Human right, others left) with label above bubble; picker scoped per
  view; Dark/Light theme (system default, persisted, WCAG AA contrast).
- **One server per database:** two lobby instances pointed at the same
  `.data/messages.db` double-capture events and double-wake the boss
  (README "Running").
- **Commit format:** `feat|fix (v1): <summary>`; push is human-only; commit
  gate (only the word "commit" commits; "approve" applies without
  committing), commit batching, and send gate â€” see `behavior.md`.
  Releases: annotated tag after version bump.
- **Onboarding:** fresh clone = `npm install` â†’ `node setup.mjs` â†’ build
  web â†’ start (README "Installation"); existing installs get read-only
  upgrade checks and `node setup.mjs --fix` (D26);
  `registering-lobby-agents` skill for new agents.
- **Historical:** the pre-v1.3.0 architecture was a zero-dependency bridge
  (`bridge.mjs`) + Vite dashboard â€” replaced by D26; full record in
  `docs/migration/`.
- Last updated: 2026-11-18 (D26 + snapshot sync).

## Decision log (approved)

- **D01** Hub-and-spoke topology; boss is the hub, each project keeps its own
  agents/sessions. â€” approved
- **D02** Address-based message log: tagged lines `[from: X] [to: Y]` in
  `incoming_messages.txt`; single inbox. â€” approved
- **D03** Token economy (mandatory): compact replies (~10 lines, no dumps),
  session-knowledge answers, no re-verification unless asked. Exception:
  project-mandated checks (e.g. Git-is-authoritative) take precedence. â€” approved
- **D04** Identity prefixes: `Boss:` = boss agent; `Human:` = human directly
  (direct human authority). â€” approved
- **D05** Sending identity: human asks the boss to send â†’ `from: "boss"`
  (`Boss:`); human explicitly claims sender â†’ `from: "human"` (`Human:`);
  web UI agent/project-row sends are `Human:`. â€” approved
- **D06** Approval gate: never message any agent without explicit human
  approval, by any channel. â€” approved (standing rule)
- **D07** Fan-out via `/send` through OpenCode prompt API (`delivery: queue`,
  non-blocking); no child `opencode run` processes. â€” approved
- **D08** Onboarding: `setup.mjs` creates `agents.json` from template
  (never overwrites), installs the global section idempotently (matches
  `## Agent Lobby` heading variants; section text = the
  `.placeholder/agents-md-section.md` source). â€” approved
- **D09** `registering-lobby-agents` skill: dedup check â†’ provision
  coordinator (copy-if-absent; never overwrite; `opencode.json`
  `default_agent: coordinator` with conflict-ask) â†’ registry name from human
  verbatim â†’ session title `(<name>)<project>` â†’ register â†’ report. â€” approved
- **D10** Web UI stack: React + Tailwind + Vite at repo root (no subfolder),
  component-per-concern, data layer in `src/data/api.ts`; bridge serves
  `dist/` at `/ui` (base `/ui/`). â€” approved
- **D11** Visibility model: All = everything; Boss view = `[from: boss]` +
  `[to: boss]` only (humanâ†’agent direct sends excluded â€” they bypass the
  boss by design); project/agent views = traffic involving their agents
  (address-based). Documented for humans in README "Message visibility".
  â€” approved after bug fix
- **D12** Composer rules: Boss view picker disabled + submit forced to
  prompt; All view = all agents pre-selected, label `To: all projects`;
  project view full-default selection â†’ label `To: <Project>`; agent view
  locked to that agent; empty selection disables Send (project/agent views).
  â€” approved
- **D13** Protocol v2: agents reply in-session; event stream captures
  `text.ended` + coalesced boss wake; webhook replies banned; `Reply sent.`
  rule deleted; README (human) / `PROTOCOL.md` (agent rules) split; Â§8.1 +
  coordinator template point to `PROTOCOL.md`. â€” approved; refresher ACKed
  by all pre-v2 agents
- **D13a** Documentation audience split (refines D13): one audience per
  document â€” `README.md` = human operations (about, features, installation,
  running, files); `PROTOCOL.md` = project-head agent rules (identity,
  replies, token economy); boss `AGENTS.md` = boss behavior only (wake
  trigger, sending identity, decision authority, relay rule, memory
  pointers). Boss-facing content does not live in `PROTOCOL.md` (slimmed to
  a reference note), and agent-facing content does not live in `README.md`.
  New docs must declare their audience before being written. â€” approved
- **D14** Synthetic echo removed: every path it covered is native now
  (webchat prompts arrive as prompts; boss sends visible as shell actions;
  `Human:` sends intentionally boss-invisible). â€” approved
- **D15** â†’ archived to `amnesia.md` (routed-copy mechanism, removed by
  human decision).
- **D16** Boss memory (under `.memory/boss/` in this repo): **`decision-log.md`**
  (committed â€” universal decision record), **`local-context.md`** (gitignored
  â€” machine state: registry, delegate rulings, local open items; seeded from
  `local-context.example.md`), **`decision-authority.md`** (committed â€”
  public mirror of the decision-authority rule + escalation list; machine
  rulings live in local-context), **`behavior.md`** (committed â€”
  behavior gates + corrections log), and **`amnesia.md`** (gitignored â€”
  archive of removed memory, explicit-ask-only; described in the boss
  agent definition so fresh clones know it should exist). Boss agent
  definition (`.opencode/agents/boss.md`) points to all five.
  â€” approved (current, D20/D21/D22)
- **D20** Public decision-authority file (`.memory/boss/decision-authority.md`):
  the delegation rule + escalation list, published for any human running
  this boss agent; machine-specific rulings stay in `local-context.md`
  (gitignored) â€” published file carries the rule, not other humans'
  project rulings. â€” approved
- **D21** Behavior memory (`.memory/boss/behavior.md`, committed): the
  behavior gates (exploratory = proposal; ambiguous gets clarified;
  draft-first; commit gate; send gate) + corrections log of the incidents
  that produced them. Boss `AGENTS.md` carries the condensed gates
  always-in-context. â€” approved
- **D17** Decision authority rule (boss `AGENTS.md`): delegated work makes the
  boss the decision authority for that work; escalate only for
  scope-change/new-feature/irreversible/credentials-or-cross-project/
  beyond-authority decisions (judgment list, refined with the human; ask when
  unsure); delegated rulings logged in memory for human audit. â€” approved
- **D18** Reply routing (refines D13): agent replies log
  `[from: <name>] [to: <last prompter>]` (lastPromptFrom map, updated by
  /send; defaults to boss); boss-session replies log `[to: human]`.
  Historical log lines keep their original tags (append-only). â€” approved
- **D19** Registration flow v2 + template identity line (restores D09's name
  gap): the coordinator template carries the identity line ("You are
  registered as this project's `name` in the lobby's `agents.json`"); the
  registering skill handles existing-coordinator projects via tolerant
  detection (heading variant or content mention) with three cases â€” append
  the template's Lobby communication section, align a differing section to
  the template copy, or leave aligned sections untouched â€” plus one identity
  message (name embedded) as the only permitted first message; reuse path
  includes the reuse/name message. The v2 rewrite had dropped the name line
  (unlogged then; that gap caused `ruben` to infer its name; its project used
  its own coordinator.md so no template copy reached it). Identity tell sent
  to ruben; TaskFlow's existing coordinator.md got the lobby section
  appended. â€” approved
- **D22** Boss agent definition (extends D13a): the boss is a defined agent
  â€” `.opencode/agents/boss.md` (frontmatter: description, mode, model pin
  glm-5.3-flash, permissions mirroring build's with browser denied). Boss
  behavior lives only in the agent definition (one audience per
  instruction file); subagents in this directory never inherit boss rules.
  The human switches sessions to the Boss agent manually. (AGENTS.md:
  retired, later reinstated project-facts-only per D24.) â€” approved
- **D23** Message database (implements O01): replace the append-only text log
  with SQLite (`node:sqlite`, zero deps) at `.data/messages.db` (gitignored);
  schema `messages(id, ts, from, to, body, session_id)` + `bookmarks(consumer,
  last_seen_id)`. Bridge writes every captured event; `incoming_messages.txt`
  retires as read-only pre-db archive; **clean start** (db begins empty,
  human decided). Reads: dashboard `GET /api/messages?view=all|boss|
  agent:<name>&after=<id>&limit=` â€” sidebar views become filtered queries
  mirroring D11 (only the `api.ts` data layer changes); boss wake = bridge
  composes the unread slice inline in the wake prompt (pure script, zero
  tokens for filtering) and advances the bookmark on delivery. **Amendment
  (2026-11-14, human-approved):** the wake slice excludes what the boss
  session already has natively â€” its own replies (`from: boss`) and the
  human's in-session prompts (`from: human, to: boss`); agent traffic and
  the human's direct sends to agents still ride; bookmark advances through
  all rows. Non-goals v1: no full-text search, no session transcripts
  (OpenCode's db owns those), no pruning. - approved

- **D24** Project `AGENTS.md` reinstated as **project facts only** (refines
  D22 â€” the retirement removed boss *behavior* to `boss.md`, which also
  removed the only auto-loaded instruction file for non-Boss sessions in
  this directory). New `AGENTS.md` audience: "any session working in this
  directory" â€” contents: the projects/ workstation convention (default
  home for projects created for this workstation; the human's delegation
  decides otherwise), pointers to `PROTOCOL.md` and `boss.md`. Boss
  behavior still lives only in the Boss agent definition. â€” approved

## Open items (system-level)

- **O01** Database storage for messages â€” **CLOSED 2026-11-14, shipped as D23**
  (store live: dashboard queries slices, wake carries the unread slice).
  Deferred minors: empty-project-view broadcast fallback; labeled test-residue
  rows in the runtime db (left as history); pre-existing `/ui` HEAD 404
  (GET-only handler); browser-only visual checks; coalescing branch
  unverified without a live browser. Also closed today: the stale file-era
  wake-trigger wording â€” boss.md now reads the inline slice below the marker
  (committed `77189c5`).
- **O02** Listener does NOT capture agent-session user inbox items (desktop
  typing into agent sessions is invisible in the log; only their replies are
  captured). Accepted v1 gap; extension = zero-token fix if wanted.
- **O03** Duplicate delivery in the prompt API â€” **RESOLVED 2026-11-18
  (evidence-based):** two distinct mechanisms confirmed. (a) Two lobby
  server instances pointed at the same `.data/messages.db` double-capture
  the same OpenCode event (~1 ms apart rows) and both wake the boss â€”
  human-observed with a :3006 instance alongside :3005; fixed by process
  rule, documented in README "Running" ("One server at a time"). (b) The
  bridge-era greg/porty duplicate (identical-ms rows in two wakes) matches
  the wake-window race (bookmark advancing after prompt instead of at
  slice-read); retired with `bridge.mjs` â€” hardening for the new server's
  wake path remains a backlog candidate.
- **O07** Boss `AGENTS.md` slimming to a `PROTOCOL.md`/decision-log pointer â€”
  CLOSED 2026-11-14: superseded by D22 (boss agent definition; AGENTS.md
  retired).
- **O08** Agent-to-agent direct messaging â€” out of scope for v1.
- **O10** Per-project memory separation (human idea): split machine memories
  into per-project files as deployments grow. Noted; not called for yet.
- **D25** Lobby-owned instructions (supersedes D08 global-install step; refines D22/D24): the user-global AGENTS.md no longer carries lobby or general instructions - AGENTS.md in this repo is the single instruction hub (audience: any session in the lobby or its managed projects; content: the human general AI-development instructions 1-10 merged from global + lobby rules 11 + the D22 boss-boundary note 12). Managed projects carry a thin pointer section in their root AGENTS.md (read ..\\..\\AGENTS.md before work) - ambient parent discovery does not apply (nested git repos stop at their own root, verified against the instructions docs). setup.mjs no longer writes to the user global file (new-user onboarding touches nothing outside the lobby folder); .placeholder/agents-md-section.md retired; registering skill provisions pointer-form; the per-project catalog stays in local-context (machine-specific). Existing projects own instructions otherwise preserved. - approved

- **D26** Architectural migration (human mission, 2026-11-17/18 - approved and
  executed, human-accepted): the lobby migrated from the zero-dependency
  bridge + Vite dashboard to a modular monolith. Backend `server/`
  (Node + TypeScript + Fastify; chat/agents/projects modules with
  domain/application/infrastructure/presentation layers; OpenCode isolated
  behind `integrations/opencode`; SQLite via Drizzle, migrations
  `0000-0003` applied at startup; internal event bus + SSE `/api/events`
  with checkpoint/`Last-Event-ID` catch-up). Frontend `web/` (Next.js +
  Tailwind + shadcn/ui, static export served at `/ui`). Legacy bridge/Vite
  retired (`809440a`). Preserved by design: `agents.json` remains the
  runtime registry (hot-reloaded; additive db mirror), API compat
  (`/api/messages`, `/api/agents`, `/api/last-activity`,
  `/api/local-projects`, `/send`, `/prompt`, `/webhook`, `/ui`), existing
  db data (additive migrations only). Operations: **one server per
  database** - two instances on the same `.data/messages.db`
  double-capture events and double-wake the boss (README "Running");
  `setup.mjs` carries read-only upgrade checks for existing installs plus
  `--fix` (port guard, sidecar-safe backup, install/build). Detail:
  `docs/migration/architecture.md` + cutover runbook. Supersedes the
  bridge-era snapshot below and D10's UI stack. - approved (executed)