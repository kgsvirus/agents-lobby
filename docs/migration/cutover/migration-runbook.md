# Cutover runbook — bridge → new server on :3005

**Owner:** Boss (only the Boss touches the canonical worktree
`F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby` and the canonical db — decision 6).
**Scope:** swap the running legacy bridge for the new stack on port 3005,
with a backup and a rollback path. Every step states its verification.
**Context:** `docs/migration/architecture.md` (what the new stack is);
Phase 7 acceptance must already be green.

PowerShell commands (Windows host). Run everything in the CANONICAL repo
folder after the migration working-tree changes have been integrated there.

## Preconditions (gate: all checked before stopping anything)

1. **New code integrated in the canonical repo** (the Boss's integration of
   the `feat/migration` working tree). Verify:
   `Test-Path server\src\app.ts` and `Test-Path web\next.config.ts` → `True`.
2. **Fresh `npm install`** at the repo root (workspaces changed).
   Verify: `npm run build -w server` → exit 0 (tsc clean);
   `npm run build -w web` → exit 0 and `Test-Path web\out\index.html` → `True`
   (`/ui` serves this export).
3. **Test suite green in the canonical repo:**
   `npx vitest run` (server+web scope) and `node --test test\*.test.mjs` → 0 fail.
   (Bare `vitest` is not on PATH in a clean shell; there is no root `test`
   script, so use `npx` — it resolves the hoisted binary, as the Phase 6 gate
   did. The legacy root tests still pass because `test/`+`store.mjs` still
   exist pre-cleanup.)
4. **Registry present:** `agents.json` exists with real session IDs.
5. **No other process bound to 3005** except the bridge.

## 0. Record a parity snapshot (BEFORE stopping the bridge)

```powershell
# NOTE: the legacy bridge has NO /api/health (its catch-all 404s every unknown
# path, bridge.mjs:445) — probe endpoints the bridge actually serves.
Invoke-RestMethod http://localhost:3005/api/agents   # registry read (bridge.mjs:255-264)
Invoke-RestMethod 'http://localhost:3005/api/messages?view=all&limit=5' | ConvertTo-Json -Depth 5 > $env:TEMP\pre-messages.json
Invoke-RestMethod http://localhost:3005/api/agents | ConvertTo-Json > $env:TEMP\pre-agents.json
Invoke-RestMethod http://localhost:3005/api/last-activity | ConvertTo-Json > $env:TEMP\pre-activity.json
```

Verify: files written; note the newest message id.

## 1. Stop the old bridge

```powershell
Get-NetTCPConnection -LocalPort 3005 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique
Stop-Process -Id <pid>          # the `node bridge.mjs` process
```

Verify: `Get-NetTCPConnection -LocalPort 3005 -State Listen` → no results;
`Invoke-RestMethod http://localhost:3005/api/agents` → connection refused.

## 2. Back up the canonical db (sidecar-safe)

The bridge has no graceful-shutdown handler (`Stop-Process` is the only stop),
so the ordered guarantee comes from step 1's verification (port closed =
no writer can interleave a write with the copy) plus a sidecar-safe copy below:
copy the main file AND every SQLite sidecar that exists (`-wal`, `-shm` - a
write in flight at termination can leave committed rows in the WAL, which a
main-file-only copy would silently lose), then fold and verify the COPY.

```powershell
$stamp = "{0:yyyyMMdd-HHmmss}" -f (Get-Date)
Copy-Item .data\messages.db ".data\messages.db.bak-$stamp"
Get-ChildItem .data\messages.db-wal, .data\messages.db-shm -ErrorAction SilentlyContinue |
  ForEach-Object { Copy-Item $_.FullName ".data\messages.db.bak-$stamp$($_.Name.Substring('messages.db'.Length))" }
# Fold the WAL into the copy (a no-op when there is no WAL):
node -e "const db=require('better-sqlite3')(process.argv[1]); db.pragma('wal_checkpoint(TRUNCATE)'); db.close()" ".data\messages.db.bak-$stamp"
# Verify the folded COPY (better-sqlite3 is installed at the repo root):
node -e "const db=require('better-sqlite3')(process.argv[1],{readonly:true}); console.log('integrity:', db.pragma('integrity_check',{simple:true})); db.close()" ".data\messages.db.bak-$stamp"
Remove-Item ".data\messages.db.bak-$stamp-wal", ".data\messages.db.bak-$stamp-shm" -ErrorAction SilentlyContinue
```

Verify (gate - stop and redo the backup if it fails): the verify command
prints **exactly** `integrity: ok` (any other value or an exception means a
bad copy). The backup is then a single self-contained file
`messages.db.bak-<stamp>` - the dry-run (step 3) and the backup-restore
rollback (step 6, corruption-only path) both operate on THIS verified file.

## 3. Migrate the db — DRY-RUN ON THE BACKUP FIRST

The server applies migrations automatically at startup (`server/src/app.ts`
→ `runMigrations`; baseline `0000` is all `IF NOT EXISTS`, proven on a
populated legacy copy by `server/test/migration.test.ts`). Dry-run first:

```powershell
Copy-Item <verified backup .data\messages.db.bak-<stamp> from step 2> .data\cutover-dryrun.db
$env:LOBBY_PORT='3008'; $env:LOBBY_DB_PATH='.data\cutover-dryrun.db'
npx tsx server/src/server.ts          # from the REPO ROOT (see cwd note below)
# in a second shell:
Invoke-RestMethod http://localhost:3008/api/health
Invoke-RestMethod 'http://localhost:3008/api/messages?view=all&limit=5' | ConvertTo-Json -Depth 5 > $env:TEMP\dryrun-messages.json
```

**cwd note (paths resolve relative to the process cwd, `config/index.ts:10-13`):**
`npx tsx server/src/server.ts` runs from the repo ROOT, so every relative
default lands where the bridge's did — `agents.json`, `./projects`,
`.data/server.auth.json` (auth file, hardcoded relative to cwd with NO env
override, `config/index.ts` `DEFAULT_AUTH_FILE`) all resolve to repo-root
paths. ⚠️ Do NOT launch with `npm run dev -w server` for cutover: npm runs
workspace scripts with cwd = `server/` (proven: the dev default created
`server\.data\dev.db` here), so the relative dry-run db path would open a NEW
db under `server\.data\` and the root `agents.json` would be missed (empty
registry). If you prefer the workspace form, give EVERY path env var an
ABSOLUTE value (`LOBBY_DB_PATH`, `LOBBY_REGISTRY_PATH`, `LOBBY_UI_DIR`,
`LOBBY_PROJECTS_DIR` — all accept absolute paths per `config/index.ts`) and
place the auth file at `server\.data\server.auth.json`.

Verify (gate — stop if it fails):
- health = `{status:"ok"}`;
- `dryrun-messages.json` deep-equals `pre-messages.json` (same rows, same ids —
  baseline does not touch legacy rows);
- startup log shows the registry mirror synced (or graceful empty if no
  `agents.json` — but precondition 4 requires it present).

Stop the dry-run server (`Get-NetTCPConnection -LocalPort 3008 … | Stop-Process -Id <pid>`).
Keep `cutover-dryrun.db` until cutover is accepted, then delete it.

## 4. Start the new server on 3005

```powershell
Remove-Item Env:LOBBY_PORT, Env:LOBBY_DB_PATH -ErrorAction SilentlyContinue
$env:LOBBY_PORT='3005'; $env:LOBBY_DB_PATH='.data\messages.db'
npx tsx server/src/server.ts          # from the REPO ROOT (same cwd note as step 3)
```

Notes:
- Same cwd rule as step 3: run from the repo root so the relative defaults
  resolve to the bridge's layout — `agents.json`, `./projects`, and the auth
  file `.data\server.auth.json` are all found at their pre-cutover locations.
  `npm run dev -w server` would instead resolve them under `server\`.
- `LOBBY_UI_DIR` default (`../web/out` relative to the server package) is
  correct for the canonical layout — no override needed after step P2.
- `LOBBY_HOST` defaults to `127.0.0.1`. The legacy bridge bound ALL interfaces
  (`server.listen(3005)` with no host, `bridge.mjs:452`). If anything outside
  localhost ever reached the lobby, add `$env:LOBBY_HOST='0.0.0.0'`.
- Migrations apply to the canonical db during THIS startup (step 3 proved the
  exact operation on a copy).
- ⚠️ There is no production `start` script yet (flagged in readme-draft.md).
  `npx tsx server/src/server.ts` is the same entry the workspace `dev` script
  runs (`tsx src/server.ts`), with the repo root as cwd; `npx` resolves the
  hoisted tsx binary (verified in the dev worktree: tsx v4.23.15 on node
  v24.19.0). Run it in a persistent shell/screen the way the bridge was run.

Verify (immediate):
- startup log: listening on 127.0.0.1:3005, no migration errors;
- `Invoke-RestMethod http://localhost:3005/api/health` → `{status:"ok"}`.

## 5. Verification gates (all must pass before declaring success)

1. **Parity spot-check:**
   ```powershell
   Invoke-RestMethod 'http://localhost:3005/api/messages?view=all&limit=5' | ConvertTo-Json -Depth 5 > $env:TEMP\post-messages.json
   Invoke-RestMethod http://localhost:3005/api/agents | ConvertTo-Json > $env:TEMP\post-agents.json
   Invoke-RestMethod http://localhost:3005/api/last-activity | ConvertTo-Json > $env:TEMP\post-activity.json
   ```
   `post-messages.json` deep-equals `pre-messages.json` (same wire rows incl.
   newest id, same view semantics); `post-agents.json` equals `pre-agents.json`
   (same entries, same file order); `post-activity.json` keys/timestamps match.
2. **Dashboard:** open `http://localhost:3005/ui` → loads with sidebar
   (Boss / All projects / projects → agents), styles and hashed assets return
   200 (F12 network), dark/light toggle works, theme persists across reload.
3. **API parity in the UI:** Boss, All, a project view and an agent view each
   show the expected historical messages (agent views include comma-list and
   NULL-receiver webhook rows).
4. **SSE live update:** send a message from the dashboard Composer → it
   appears in the feed and in the target view without reload; new message id
   is `pre id + 1`-adjacent (no gaps introduced).
5. **Wake flow:** send a message to an agent (Composer, agent/project row) →
   the agent's session receives the `Human: …` prompt; when the agent replies
   in-session, the reply is captured and the BOSS session receives the
   `[message received]` wake with the unread slice (verify in the boss
   session / OpenCode UI). **Fresh-connection check:** hard-reload the
   dashboard tab — the new EventSource carries no `Last-Event-ID`, gets zero
   history replay (only the `lobby.checkpoint` cursor seed), and the next
   message arrives live. (A genuine dropped-connection RECONNECT with
   `Last-Event-ID` replay was verified by the server suite
   (`server/test/sse.test.ts`: checkpoint-cursor + gap-replay cases), not in
   this manual pass — simulating a dropped socket mid-session is not part of
   this runbook.)
6. **Optional secret auth:** if `.data/server.auth.json` existed pre-cutover,
   `/send` without the bearer now returns 401 - confirm or remove the file.
   **Known limitation:** with the token enabled, the dashboard composer's
   `/send`/`/prompt` calls return 401 - the UI has no token entry yet (the
   secret is never embedded in the web bundle). `/api/events` and the other
   reads stay open (decision-4 scope: the token gates `/send` + `/prompt`
   only, because EventSource cannot send an Authorization header). The
   dashboard is a same-host trusted-client UI; token-based UI auth is a
   post-cutover follow-up. While the token is enabled, verify the composer
   gates with a direct client (e.g. `Invoke-RestMethod -Headers
   @{Authorization='Bearer <token>'}`), or remove the file to use the
   dashboard.

## 6. ROLLBACK (any gate fails)

**Default rollback — do NOT restore the db.** The migrations leave the legacy
`messages`/`bookmarks` tables byte-intact (baseline `0000` is all
`IF NOT EXISTS`; 0001–0003 only ADD mirror/event tables), and the legacy
`store.mjs` interoperates with the migrated file (cross-implementation
bookmark/row interop is proven on the same file by
`server/test/chat-store.test.ts`). The verify gates (step 5) create REAL
messages; restoring the step-2 backup would silently DELETE them.

```powershell
# stop the new server
Get-NetTCPConnection -LocalPort 3005 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ }
# restart the bridge on the SAME (already migrated) db
node bridge.mjs
```

Verify: `Invoke-WebRequest http://localhost:3005/ui` → 200 (bridge has no
health route) and the dashboard on :3005/ui shows the full pre-cutover history
PLUS any messages created during the verify window. The canonical db now also
carries the new mirror/`events` tables — harmless to the bridge (it queries
only `messages`/`bookmarks`) and permanent either way.

**Backup-restore rollback — ONLY if the migrated db is corrupt/failing** (the
server cannot start or reads are broken): stop the new server, restore the
VERIFIED step-2 backup (`Copy-Item <backup-file> .data\messages.db -Force`),
drop any stale sidecars the failed db left
(`Remove-Item .data\messages.db-wal, .data\messages.db-shm -ErrorAction
SilentlyContinue`), and restart the bridge.
**Tradeoff:** messages created during the verify window exist only in the
post-backup db — restoring the backup loses those STORE rows (the agents
themselves still received any delivered prompts; the lobby's record of them
is gone). Record the loss when this path is taken.

After either rollback path: report the failed gate and regroup; the dev
worktree remains the source for fixes.

## 7. Post-cutover cleanup (Boss's call, separate step)

- Delete obsolete bridge code: `bridge.mjs`, `store.mjs`, `local-projects.mjs`,
  `test/`, `src/`, `dist/`, `vite.config.ts` (+ root Vite scripts in
  `package.json`, per work order §6 "delete obsolete bridge code only at
  cutover").
- Update `README.md` from `docs/migration/cutover/readme-draft.md`; PROTOCOL.md
  needs no change (`docs/migration/cutover/protocol-draft.md`).
- Optional consolidation flagged by Phase 5: `registry_mirror` (0001) is a
  write-only projection; merging it into `agents` (0002) is a Boss decision,
  NOT part of this runbook.
- ⚠️ First commit should pin migrations 0000–0003 (untracked-file hashes were
  unverifiable during development — ledger note, task 7).

## Unverified items

- Running the server from `server/dist/` (`node server\dist\server.js` after
  `build -w server`) is designed-for (`database/client.ts` comment) but never
  exercised — the runbook uses tsx.
- The wake-flow gate (5) depends on live OpenCode behavior observed at cutover
  time; all offline equivalents (byte-identity tests, `chat-wake.test.ts`) are
  green, but the live check itself cannot be pre-run against the canonical
  OpenCode server.
