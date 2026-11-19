# Decision Log - Agents-Lobby Boss

> Purpose: the approved decision record of the lobby system itself - universal
> across machines. This file is committed; new machines inherit the full
> decision history on clone. Machine-specific state lives in
> `local-context.md` (gitignored, seeded by `setup.mjs`).
>
> ## Vision
>
> Agents-Lobby is meant to grow into a **human assistant for everyday work** -
> the boss agent as the human's standing delegate across projects and daily
> tasks. Current refinements are steps toward that: every change should be
> judged against "does this move the lobby toward being the human's everyday
> assistant?"
>
> Memory governance rules (dedup, maintenance, classification, docs-sync,
> circularity, necessity, memory-change consent) live in `behavior.md` -
> "Memory governance" section. Removed memory is archived to `amnesia.md`
> (gitignored, dated, with reason).
>
> Last updated: 2026-11-19 (D27 role-based peer policy, D28 wake boundary,
> D29 policy/credential files not agent-editable; O11 flake noted; D26
> architectural migration + snapshot sync; governance rules moved to
> behavior.md).

## System snapshot (universal facts)

- **Architecture:** hub-and-spoke. Boss agent (Agents-Lobby project) <->
  project-head agents, each project keeping its own agents/sessions.
- **Server** (`server/`, Fastify + TypeScript, port 3005 in production):
  modular monolith - chat/agents/projects modules, OpenCode integration
  isolated in `integrations/opencode`, SQLite via Drizzle
  (`.data/messages.db`, migrations applied at startup), internal event bus
  + SSE `/api/events`. Endpoints: `/send` (fan-out, `from: human|boss`),
  `/prompt` (webchat -> boss), `/webhook` (backward-compat), `/ui`
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
  `/ui`): sidebar Boss -> All -> projects -> agents; sender-based alignment
  (Human right, others left) with label above bubble; picker scoped per
  view; Dark/Light theme (system default, persisted, WCAG AA contrast).
- **One server per database:** two lobby instances pointed at the same
  `.data/messages.db` double-capture events and double-wake the boss
  (README "Running").
- **Commit format:** `feat|fix (v1): <summary>`; push is human-only; commit
  gate (only the word "commit" commits; "approve" applies without
  committing), commit batching, and send gate - see `behavior.md`.
  Releases: annotated tag after version bump.
- **Onboarding:** fresh clone = `npm install` -> `node setup.mjs` -> build
  web -> start (README "Installation"); existing installs get read-only
  upgrade checks and `node setup.mjs --fix` (D26);
  `registering-lobby-agents` skill for new agents.
- **Historical:** the pre-v1.3.0 architecture was a zero-dependency bridge
  (`bridge.mjs`) + Vite dashboard - replaced by D26; full record in
  `docs/migration/`.
- Last updated: 2026-11-18 (D26 + snapshot sync).

## Decision log (approved)

- **D01** Hub-and-spoke topology; boss is the hub, each project keeps its own
  agents/sessions. - approved
- **D02** Address-based message log: tagged lines `[from: X] [to: Y]` in
  `incoming_messages.txt`; single inbox. - approved
- **D03** Token economy (mandatory): compact replies (~10 lines, no dumps),
  session-knowledge answers, no re-verification unless asked. Exception:
  project-mandated checks (e.g. Git-is-authoritative) take precedence. - approved
- **D04** Identity prefixes: `Boss:` = boss agent; `Human:` = human directly
  (direct human authority). - approved
- **D05** Sending identity: human asks the boss to send -> `from: "boss"`
  (`Boss:`); human explicitly claims sender -> `from: "human"` (`Human:`);
  web UI agent/project-row sends are `Human:`. - approved
- **D06** Approval gate: never message any agent without explicit human
  approval, by any channel. - approved (standing rule)
- **D07** Fan-out via `/send` through OpenCode prompt API (`delivery: queue`,
  non-blocking); no child `opencode run` processes. - approved
- **D08** Onboarding: `setup.mjs` creates `agents.json` from template
  (never overwrites), installs the global section idempotently (matches
  `## Agent Lobby` heading variants; section text = the
  `.placeholder/agents-md-section.md` source). - approved
- **D09** `registering-lobby-agents` skill: dedup check -> provision
  coordinator (copy-if-absent; never overwrite; `opencode.json`
  `default_agent: coordinator` with conflict-ask) -> registry name from human
  verbatim -> session title `(<name>)<project>` -> register -> report. - approved
- **D10** Web UI stack: React + Tailwind + Vite at repo root (no subfolder),
  component-per-concern, data layer in `src/data/api.ts`; bridge serves
  `dist/` at `/ui` (base `/ui/`). - approved
- **D11** Visibility model: All = everything; Boss view = `[from: boss]` +
  `[to: boss]` only (human->agent direct sends excluded - they bypass the
  boss by design); project/agent views = traffic involving their agents
  (address-based). Documented for humans in README "Message visibility".
  - approved after bug fix
- **D12** Composer rules: Boss view picker disabled + submit forced to
  prompt; All view = all agents pre-selected, label `To: all projects`;
  project view full-default selection -> label `To: <Project>`; agent view
  locked to that agent; empty selection disables Send (project/agent views).
  - approved
- **D13** Protocol v2: agents reply in-session; event stream captures
  `text.ended` + coalesced boss wake; webhook replies banned; `Reply sent.`
  rule deleted; README (human) / `PROTOCOL.md` (agent rules) split; section 8.1 +
  coordinator template point to `PROTOCOL.md`. - approved; refresher ACKed
  by all pre-v2 agents
- **D13a** Documentation audience split (refines D13): one audience per
  document - `README.md` = human operations (about, features, installation,
  running, files); `PROTOCOL.md` = project-head agent rules (identity,
  replies, token economy); boss `AGENTS.md` = boss behavior only (wake
  trigger, sending identity, decision authority, relay rule, memory
  pointers). Boss-facing content does not live in `PROTOCOL.md` (slimmed to
  a reference note), and agent-facing content does not live in `README.md`.
  New docs must declare their audience before being written. - approved
- **D14** Synthetic echo removed: every path it covered is native now
  (webchat prompts arrive as prompts; boss sends visible as shell actions;
  `Human:` sends intentionally boss-invisible). - approved
- **D15** -> archived to `amnesia.md` (routed-copy mechanism, removed by
  human decision).
- **D16** Boss memory (under `.memory/boss/` in this repo): **`decision-log.md`**
  (committed - universal decision record), **`local-context.md`** (gitignored
  - machine state: registry, delegate rulings, local open items; seeded from
  `local-context.example.md`), **`decision-authority.md`** (committed -
  public mirror of the decision-authority rule + escalation list; machine
  rulings live in local-context), **`behavior.md`** (committed -
  behavior gates + corrections log), and **`amnesia.md`** (gitignored -
  archive of removed memory, explicit-ask-only; described in the boss
  agent definition so fresh clones know it should exist). Boss agent
  definition (`.opencode/agents/boss.md`) points to all five.
  - approved (current, D20/D21/D22)
- **D20** Public decision-authority file (`.memory/boss/decision-authority.md`):
  the delegation rule + escalation list, published for any human running
  this boss agent; machine-specific rulings stay in `local-context.md`
  (gitignored) - published file carries the rule, not other humans'
  project rulings. - approved
- **D21** Behavior memory (`.memory/boss/behavior.md`, committed): the
  behavior gates (exploratory = proposal; ambiguous gets clarified;
  draft-first; commit gate; send gate) + corrections log of the incidents
  that produced them. Boss `AGENTS.md` carries the condensed gates
  always-in-context. - approved
- **D17** Decision authority rule (boss `AGENTS.md`): delegated work makes the
  boss the decision authority for that work; escalate only for
  scope-change/new-feature/irreversible/credentials-or-cross-project/
  beyond-authority decisions (judgment list, refined with the human; ask when
  unsure); delegated rulings logged in memory for human audit. - approved
- **D18** Reply routing (refines D13): agent replies log
  `[from: <name>] [to: <last prompter>]` (lastPromptFrom map, updated by
  /send; defaults to boss); boss-session replies log `[to: human]`.
  Historical log lines keep their original tags (append-only). - approved
- **D19** Registration flow v2 + template identity line (restores D09's name
  gap): the coordinator template carries the identity line ("You are
  registered as this project's `name` in the lobby's `agents.json`"); the
  registering skill handles existing-coordinator projects via tolerant
  detection (heading variant or content mention) with three cases - append
  the template's Lobby communication section, align a differing section to
  the template copy, or leave aligned sections untouched - plus one identity
  message (name embedded) as the only permitted first message; reuse path
  includes the reuse/name message. The v2 rewrite had dropped the name line
  (unlogged then; that gap caused `ruben` to infer its name; its project used
  its own coordinator.md so no template copy reached it). Identity tell sent
  to ruben; TaskFlow's existing coordinator.md got the lobby section
  appended. - approved
- **D22** Boss agent definition (extends D13a): the boss is a defined agent
  - `.opencode/agents/boss.md` (frontmatter: description, mode, model pin
  glm-5.3-flash, permissions mirroring build's with browser denied). Boss
  behavior lives only in the agent definition (one audience per
  instruction file); subagents in this directory never inherit boss rules.
  The human switches sessions to the Boss agent manually. (AGENTS.md:
  retired, later reinstated project-facts-only per D24.) - approved
- **D23** Message database (implements O01): replace the append-only text log
  with SQLite (`node:sqlite`, zero deps) at `.data/messages.db` (gitignored);
  schema `messages(id, ts, from, to, body, session_id)` + `bookmarks(consumer,
  last_seen_id)`. Bridge writes every captured event; `incoming_messages.txt`
  retires as read-only pre-db archive; **clean start** (db begins empty,
  human decided). Reads: dashboard `GET /api/messages?view=all|boss|
  agent:<name>&after=<id>&limit=` - sidebar views become filtered queries
  mirroring D11 (only the `api.ts` data layer changes); boss wake = bridge
  composes the unread slice inline in the wake prompt (pure script, zero
  tokens for filtering) and advances the bookmark on delivery. **Amendment
  (2026-11-14, human-approved):** the wake slice excludes what the boss
  session already has natively - its own replies (`from: boss`) and the
  human's in-session prompts (`from: human, to: boss`); agent traffic and
  the human's direct sends to agents still ride; bookmark advances through
  all rows. Non-goals v1: no full-text search, no session transcripts
  (OpenCode's db owns those), no pruning. - approved

- **D24** Project `AGENTS.md` reinstated as **project facts only** (refines
  D22 - the retirement removed boss *behavior* to `boss.md`, which also
  removed the only auto-loaded instruction file for non-Boss sessions in
  this directory). New `AGENTS.md` audience: "any session working in this
  directory" - contents: the projects/ workstation convention (default
  home for projects created for this workstation; the human's delegation
  decides otherwise), pointers to `PROTOCOL.md` and `boss.md`. Boss
  behavior still lives only in the Boss agent definition. - approved

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

- **D27** Peer policy is ROLE-based (supersedes the same day's name-based ACL):
  `agents.json` carries an optional `role` per agent (absent = inert: it can
  neither send nor be addressed); `config/peer-to-peer-allowlist.json` maps
  role -> roles it may address, with no wildcard; `to` accepts a role (fans out
  to every holder, one row naming them, one prompt each), an agent name (only
  if that agent's role is permitted), `boss`, or `human` (archive-only). Peers
  may not use `to: "all"`. Registry validation is loud: reserved roles
  (`human`/`boss`/`all`), invalid role or name characters are refused at load,
  and a duplicated agent name stays listable but cannot send
  (`409 ambiguous_sender`). - approved

- **D28** Wake boundary: the boss is woken ONLY by traffic addressed to `boss`
  (plus legacy null-receiver captures). Every human row, peer-to-peer row and
  agent -> human reply is excluded from the slice, and a wake with nothing
  unread prompts nobody (no empty wakes). Supersedes D23's amendment (which
  kept the human's direct sends to agents in the slice) and the earlier
  peer-only exclusion. - approved

- **D29** Policy and credential files are not agent-editable: `agents.json`
  (registry + roles), `config/peer-to-peer-allowlist.json` and
  `.data/peer-auth.json` change only on an explicit human or boss instruction;
  agents ask, they do not self-serve - a role, a pair or a token edit is
  privilege escalation. Standing rule in `PROTOCOL.md` ("Policy and
  credentials are not yours to edit"). - approved

- **D30** The dashboard connects itself: in identity mode the server mints an
  `HttpOnly; SameSite=Strict` session cookie for the `human` principal on
  `POST /api/connect`, so nobody pastes a token. Guards: identity mode only
  (refused in open/shared-token), loopback bind + loopback peer, no proxy
  headers (`x-forwarded-for`/`forwarded`/`x-real-ip`), loopback `Host` name, and
  an `x-lobby-connect` header a cross-site form cannot send. Agent bearer
  tokens are unchanged; an invalid `Authorization` never falls back to the
  cookie. The shared-token paste stays as the only browser path in that mode.
  Disconnect signs out the tab's UI; the cookie itself is browser-wide.
  - approved (design + implementation; commit pending the human)

- **D31** One orchestrator per project, two templates by purpose - **do not
  delete `coordinator.md`**: `.placeholder/agent/scrum-master.md` is what new
  projects ship and what `default_agent` names; `.placeholder/agent/coordinator.md`
  is KEPT (2026-11-19) because re-spawning a TaskFlow agent (greg/ruben/Dummy)
  needs its coordinator template - deleting it would leave hand-writing as the
  only way back. Both are `mode: primary`; their model-routing text is
  byte-identical so they cannot tell an agent different things, and neither
  carries a lobby section (the rules live only in `PROTOCOL.md`). Existing
  projects keep their own `coordinator.md` copies and new projects get
  scrum-master. The **role** `coordinator` in `agents.json` / the peer
  allowlist is policy, unrelated to either file. (Absorbs the former D33;
  archived in `amnesia.md`.) - approved (apply without commit)

- **D32** Model routing lives in the orchestrator templates only:
  `scrum-master.md` and `coordinator.md` carry the full policy inline,
  byte-identical; no peer agent carries a copy or a pointer, and
  `docs/model-routing.md` was created then deleted. The rules themselves are
  unchanged (no explicit `model` on dispatch, the target's own frontmatter is
  the source of truth, no hardcoded IDs, no configured model -> stop and ask, no
  override without explicit human authorization, this policy outranks installed
  skills). - approved (apply without commit)

- **D34** Registration contract: (a) order is session creation, then the
  `agents.json` row, then the identity message - a message cannot be sent before
  the session exists, and it must not claim "registered" before the row is
  written; (b) the row is **updated when the session is already listed** and
  appended only otherwise - one session must never appear twice (a duplicate
  name gives `409 ambiguous_sender`, a duplicate session keeps attributing
  replies to the old name); (c) all three project invariants from
  `creating-lobby-projects` are applied (steps 3-5), so a written
  `default_agent` always names a file that exists; (d) an existing agent file
  is never overwritten silently - the human chooses **replace / merge /
  backup** (merge keeps existing lines and frontmatter, adds only missing body
  sections; backup = `.bak-YYYYMMDD-HHmmss` then replace). - approved (apply
  without commit)

## Open items (system-level)

- **O02** Listener does NOT capture agent-session user inbox items (desktop
  typing into agent sessions is invisible in the log; only their replies are
  captured). Accepted v1 gap; extension = zero-token fix if wanted.
- **O08** Agent-to-agent direct messaging - **DELIVERED**, not out of scope:
  peer `/send` with role-based addressing, the allowlist policy, and the wake
  boundary (D22, D27, D28; rules in `PROTOCOL.md`). Kept here only as the record
  of the original v1 boundary; nothing is pending on it.
- **O10** Per-project memory separation (human idea): split machine memories
  into per-project files as deployments grow. Noted; not called for yet.
- **O11** `server/test/chat-dedup.test.ts` "busy retries YIELD the event loop"
  is load-flaky: it asserts a wall-clock timer-tick floor (>=3 ticks in ~1.4 s)
  and fails in roughly half of full-suite runs while passing in isolation. The
  behaviour it guards (async yield instead of a synchronous park) is real and
  covered by the design; the test's timing dependency is the defect. Fix by
  removing the wall-clock dependency (fake clock or deterministic tick
  accounting), never by lowering the floor. Noted 2026-11-19 from the ruben
  review; the maintenance-ledger original was deleted with its workspace.
