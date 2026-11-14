# Message Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the append-only `incoming_messages.txt` with a SQLite store; the dashboard and boss wake read slices instead of the whole file.

**Architecture:** One new module `store.mjs` (SQLite via `node:sqlite`, zero deps) owns insert/query/bookmarks. `bridge.mjs` capture points write rows instead of log lines; `/api/messages` gains query params; the boss wake prompt carries the unread slice inline. UI keeps its components and client-side view filtering — only the data layer changes.

**Tech Stack:** Node ≥22.5 `node:sqlite` (`DatabaseSync`), existing zero-dep `bridge.mjs`, existing React dashboard.

**Spec:** `.memory/boss/decision-log.md` → **D23** (approved design; the plan argues from it).

## Global Constraints

- **Zero new npm dependencies** — `node:sqlite` only (machine runs Node 24.19)
- **No commits by the implementer** — the lobby commit gate: human says "commit"; each task ends with "tests pass, ready for commit" instead
- Wire shape per message is `{ id: number, time: string (ISO UTC), from: string, to: string | null, text: string }` — existing UI field names (`time/from/to/text`) preserved, `id` added
- View filtering semantics mirror **D11** exactly: `all` = everything; `boss` = `from === 'boss'` OR `to === 'boss'`; `agent:<name>` = sender is name OR `to` is `'all'` or a comma-separated list containing name; `project:<name>` = any of that project's agents involved
- Clean start: db file `.data/messages.db` gitignored; `incoming_messages.txt` never written again (archive only)

## Review Focus

1. **Multi-line bodies** — a reply containing `\n` must store and return byte-identical (test in Task 1 pins it)
2. **Empty db** — every query on a fresh db returns `[]`, never throws (Task 1)
3. **Wake with zero unread** — no wake prompt is composed from an empty slice (Task 4)
4. **`to`-list membership** — `'taskflow, ruben'` matches `agent:ruben` and the project of either (Task 1)
5. **`after=0` initial load** — returns the *latest* `limit` rows ascending, not the oldest and not empty (Task 1)

---

### Task 1: `store.mjs` — the message store

**Files:**
- Create: `store.mjs`
- Test: `test/store.test.mjs`

**Interfaces:**
- Consumes: nothing (leaf module)
- Produces (Tasks 2–4 rely on exactly these):
  - `openStore(file = './.data/messages.db')` → `{ insert, query, unread, markSeen, close }`
  - `insert({ ts, from, to, body, sessionId = null })` → `{ id }`
  - `query({ view = 'all', after = 0, limit = 500, agents = [] })` → rows **ascending** `[{ id, time, from, to, text }]`; `after = 0` means *latest* `limit` rows; `view` is `'all' | 'boss' | 'agent:<name>' | 'project:<name>'`; `agents` = registry names of the project's agents (for `project:<name>`)
  - `unread(consumer = 'boss')` → rows with `id > bookmark(consumer)`, ascending
  - `markSeen(consumer = 'boss')` → advances bookmark to `MAX(messages.id)` (no-op on empty table)
  - `close()`

- [ ] **Step 1: Write the failing test** — `test/store.test.mjs` using `node:test` + `assert`, temp db file in `os.tmpdir()`:

  - empty-db: `query` and `unread` return `[]`; `markSeen` no-op
  - insert 3 rows (boss→agent; agent→boss; human→`'taskflow, ruben'` with a **two-line body** `"line one\nline two"`)
  - `query({ view: 'all' })` → 3 rows ascending, ids 1,2,3; the two-line body round-trips exactly
  - `query({ view: 'boss' })` → only rows with `from='boss'` or `to='boss'`
  - `query({ view: 'agent:ruben' })` → agent row + the human row (list membership), not boss→other-agent
  - `query({ view: 'project:TaskFlow', agents: ['taskflow','ruben'] })` → same set as either agent view
  - `query({ after: 2 })` → only id 3
  - `query({ after: 0, limit: 2 })` → ids 2,3 ascending (latest 2)
  - `unread('boss')` before any mark → **all rows since bookmark** (the boss's wake replaces today's whole-log read, so it sees all captured traffic; ruling 2026-11-14, design wins over the earlier test phrasing); `markSeen('boss')` → `unread('boss')` = `[]`

- [ ] **Step 2: Run** `node --test test/store.test.mjs` — expect FAIL (module missing)

- [ ] **Step 3: Implement** `store.mjs` — `DatabaseSync` from `node:sqlite`; `mkdir` the db dir; schema:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  sender TEXT NOT NULL, receiver TEXT, body TEXT NOT NULL, session_id TEXT);
CREATE TABLE IF NOT EXISTS bookmarks (
  consumer TEXT PRIMARY KEY, last_seen_id INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_msg_receiver ON messages(receiver, id);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender, id);
```

  `to`-list matching: `receiver = 'all' OR receiver = ? OR (',' || REPLACE(receiver, ' ', '') || ',') LIKE '%,' || ? || ',%'` pattern (normalize spaces when matching). `after = 0` → `SELECT ... WHERE id > 0 ORDER BY id DESC LIMIT ?` then reverse in JS.

- [ ] **Step 4: Run** `node --test test/store.test.mjs` — expect PASS

- [ ] **Step 5: Report task complete — no commit (lobby gate)**

### Task 2: Bridge writes to the store

**Files:**
- Modify: `bridge.mjs` (capture points at lines ~104–119 `appendMessage`, ~155–188 listener, ~262 webhook, ~335 `/send`)

**Interfaces:**
- Consumes: Task 1 `openStore`/`insert`
- Produces: module-level `const store = await openStore();` — every former `appendMessage(line)` call becomes `await store.insert({ ts: new Date().toISOString(), from, to, body, sessionId: d.sessionID ?? null })` with `from`/`to` parsed from the existing string constructions

- [ ] **Step 1: Replace** `appendMessage` with a thin `saveMessage({ from, to, body, sessionId })` → `store.insert(...)`; update all four capture points (listener inbox-enqueue, listener `text.ended` boss + agent branches, `/webhook`, `/send`) — parse `to` lists with the same `', '` join already used
- [ ] **Step 2: Delete** the file-append logic; `MESSAGE_FILE` constant removed; no other log writes remain (`grep appendMessage bridge.mjs` → no matches)
- [ ] **Step 3: Run** `node --test test/store.test.mjs` (still PASS) + `node --check bridge.mjs`
- [ ] **Step 4: Smoke-test manually**: restart bridge, send via `/send`, confirm `SELECT COUNT(*)` grows in `.data/messages.db` and `incoming_messages.txt` does not
- [ ] **Step 5: Report task complete — no commit (lobby gate)**

### Task 3: `GET /api/messages` gains query params

**Files:**
- Modify: `bridge.mjs` (`/api/messages` handler, lines ~234–252)

**Interfaces:**
- Consumes: Task 1 `query`
- Produces: `GET /api/messages?view=all|boss|agent:<name>|project:<name>&after=<id>&limit=<n>` → JSON array of `{ id, time, from, to, text }`; defaults `view=all`, `after=0`, `limit=500`; `project:<name>` passes that project's agent names from `loadRegistry()`

- [ ] **Step 1: Rewrite** the handler: parse `new URL(req.url, 'http://x')` search params, call `store.query({ view, after, limit, agents })`, respond rows; field mapping `ts → time`, `sender → from`, `receiver → to`, `body → text`
- [ ] **Step 2: Verify**: `curl "http://localhost:3005/api/messages?view=boss&after=0&limit=10"` returns filtered rows; `?after=<lastId>` returns only newer
- [ ] **Step 3: Report task complete — no commit (lobby gate)**

### Task 4: Boss wake carries the unread slice

**Files:**
- Modify: `bridge.mjs` (`wakeBoss`, lines ~88–102)

**Interfaces:**
- Consumes: Task 1 `unread` / `markSeen`
- Produces: wake prompt text = `"[message received]"` + `\n\n` + one line per unread message `[<ts>] [from: <from>] [to: <to>] <text>` (only when unread is non-empty); bookmark advances **at enqueue time** (`markSeen('boss')` right after the prompt is queued)

- [ ] **Step 1: Rewrite** `wakeBoss`: keep the inbox pending-wake coalescing check; when enqueueing, compose the prompt from `store.unread('boss')`; skip composing an empty slice (plain `WAKE_PROMPT` fallback for wake-without-messages); `markSeen` after successful enqueue
- [ ] **Step 2: Known limit, commented in code** — `shortcut: coalesced messages arriving between enqueue and boss processing wait for the next agent-reply wake; upgrade when the server supports editing a pending inbox item`
- [ ] **Step 3: Verify live**: have an agent reply (or use `/send` to an agent and get its reply) → the boss session receives the wake with the message inline; a second coalesced message appears in the *next* wake
- [ ] **Step 4: Report task complete — no commit (lobby gate)**

### Task 5: UI data layer — incremental fetch

**Files:**
- Modify: `src/data/api.ts` (`Message` interface, `fetchMessages`, lines ~8–25)
- Modify: `src/hooks/useMessages.ts` (polling tick)

**Interfaces:**
- Consumes: Task 3 endpoint
- Produces: `fetchMessages(view: View | null = null, after = 0, limit = 500): Promise<Message[]>`; `Message` gains `id: number`; `useMessages()` keeps its signature — internal `lastId` ref, initial `after=0&limit=500`, tick fetches `after=<lastId>` and appends; client-side filtering (`isVisible`) unchanged; `view` param passed only when non-null (hook passes `null`)

- [ ] **Step 1: Update** `api.ts` (`Message` + `fetchMessages` + a tiny `viewParam(view)` helper: `all | boss | agent:<name> | project:<name>`); keep `involves`/`isVisible` untouched
- [ ] **Step 2: Update** `useMessages.ts` tick to incremental append (dedupe by id, tolerate bridge-down as today)
- [ ] **Step 3: Build + verify**: `npm run build`; bridge serves `/ui`; sidebar views render identically to before; sending a message makes it appear within one poll without refetching history
- [ ] **Step 4: Report task complete — no commit (lobby gate)**

### Task 6: Housekeeping + docs sync

**Files:**
- Modify: `.gitignore` (add `.data/`)
- Modify: `README.md` (files table: replace the log row with `.data/messages.db` store row; note `incoming_messages.txt` = pre-db archive)
- Modify: `src/vite-env.d.ts` or types — only if `npm run build` flags the changed `api.ts`

- [ ] **Step 1:** `.gitignore` + README rows
- [ ] **Step 2:** Full pass: `node --test test/store.test.mjs`, `npm run build`, restart bridge, one live round-trip (`/send` → reply → wake → UI shows all three)
- [ ] **Step 3:** Report everything green — **hand off to the human**: commit scopes proposed as (1) `feat (v1): message database - bridge store + api` (store.mjs, bridge.mjs, .gitignore), (2) `feat (v1): message database - dashboard incremental fetch` (src/), (3) `docs (v1): message database - README + O01 close` (README, decision-log O01)
