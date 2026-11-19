# Dashboard auto-connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the human's token paste by letting a loopback browser obtain an HttpOnly `human` session cookie, while agent bearer tokens stay exactly as they are.

**Architecture:** A cookie-session adapter sits beside the existing token adapter. Both feed one resolver that produces the same `Principal` the send path already consumes; the send service, role policy and wake boundary are untouched.

**Tech Stack:** Node 24, TypeScript, Fastify 5, vitest, Next.js static export (built on the E: station).

**Spec:** `docs/superpowers/specs/2026-11-19-dashboard-auto-connect-design.md`

## Global Constraints

- Loopback only: `/api/connect` refuses non-loopback peers and a non-loopback `LOBBY_HOST`.
- Cookie: `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`. Sessions in memory; restart signs browsers out.
- A bearer token always wins over the cookie; the cookie only ever maps to `human`.
- No secret in a log: redact `req.headers.cookie` as well as `authorization`.
- Agent tokens, role policy and wake boundary do not change.
- Commit only on the human's explicit "commit".
- Verify with `npm test` and `npm run build -w server`.

## Review Focus

- Loopback behind a proxy: a request arriving via a reverse proxy shows 127.0.0.1 - decide and test what `trustProxy` should be (default off).
- `X-Forwarded-For` must never be honoured for the loopback decision.
- Cookie replay after disconnect: the old session id must be rejected, not merely ignored by the browser.
- Two browsers on one machine: separate sessions, one disconnect does not sign the other out.
- Token + cookie together: the token's identity must win, never a silent downgrade to `human`.
- Restart: an old cookie must not authenticate (in-memory map is empty).

---

### Task 1: Session store and cookie helpers

**Files:**
- Create: `server/src/api/middleware/session.ts`
- Test: `server/test/session.test.ts`

**Interfaces:**
- Produces:
  - `class SessionStore` with `create(principal: Principal): string`, `get(id: string): Principal | undefined`, `delete(id: string): void`, `size(): number`.
  - `SESSION_COOKIE = 'lobby_session'`
  - `readSessionId(cookieHeader: string | undefined): string | null`
  - `sessionCookie(id: string): string` (the `Set-Cookie` value with the flags above)

- [ ] **Step 1: Write the failing tests**

```ts
it('creates, reads and deletes a session', () => {
  const store = new SessionStore();
  const id = store.create({ name: 'human', kind: 'human' });
  expect(id.length).toBeGreaterThanOrEqual(32);
  expect(store.get(id)).toEqual({ name: 'human', kind: 'human' });
  store.delete(id);
  expect(store.get(id)).toBeUndefined();
  expect(store.size()).toBe(0);
});

it('parses the cookie header and emits the hardened cookie', () => {
  expect(readSessionId(`a=1; ${SESSION_COOKIE}=abc; b=2`)).toBe('abc');
  expect(readSessionId('a=1')).toBeNull();
  expect(sessionCookie('abc')).toContain('HttpOnly');
  expect(sessionCookie('abc')).toContain('SameSite=Strict');
  expect(sessionCookie('abc')).toContain('Max-Age=43200');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run server/test/session.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

Random id from `crypto.randomBytes(32).toString('base64url')`; a `Map`; parsing by splitting on `;` and `=`; `sessionCookie` returns `lobby_session=<id>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`.

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run server/test/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (only on the human's word)**

---

### Task 2: Connect / disconnect routes and dual credential resolution

**Files:**
- Modify: `server/src/modules/chat/presentation/routes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/server.ts` (log redaction)
- Test: `server/test/chat-peer-routes.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `readSessionId`, `sessionCookie` (Task 1); `Principal` (config).
- Produces: `POST /api/connect` -> `{name, kind}` + `Set-Cookie`; `POST /api/disconnect` -> `{status:'ok'}` + cleared cookie; `requireCredential(principals, sessions)` used by `/send` + `/prompt` + `/api/principal`.

- [ ] **Step 1: Write the failing tests**

- `/api/connect` from loopback returns `{name:'human',kind:'human'}` and a `lobby_session` Set-Cookie with `HttpOnly`.
- `GET /api/principal` with only that cookie returns the human principal.
- `/send` with only the cookie: `to:'boss'` -> 200 and the row's sender is `human` (assert via the injected store/`/api/messages`), and `from:'boss'` -> 403 identity_mismatch.
- `/api/disconnect` -> the same cookie then yields 401 on `/api/principal`.
- With `LOBBY_HOST='0.0.0.0'` the connect route is 403 and sets no cookie.
- A bearer token with no cookie still works; with both, the token identity wins (connect a cookie, then call `/send` with ruben's token -> sender ruben, not human).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run server/test/chat-peer-routes.test.ts`
Expected: FAIL on the new cases (404 on `/api/connect`).

- [ ] **Step 3: Implement**

`requireCredential(principals, sessions)` = try `tokenToPrincipal`, then `readSessionId` -> `sessions.get`. On `/api/connect`: refuse unless `request.socket.remoteAddress` is loopback and `config.host` is loopback; create the session; `reply.header('set-cookie', sessionCookie(id))`. On `/api/disconnect`: delete the cookie's session and set an expired cookie. Keep the legacy shared-token path when no principals are configured.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run server/test/chat-peer-routes.test.ts server/test/chat-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Redaction + commit**

`server.ts` logger redaction gains `req.headers.cookie`; pin it in `server/test/peer-auth.test.ts` (a logged request must not contain the cookie value).

---

### Task 3: Dashboard auto-connect

**Files:**
- Modify: `web/src/lib/api.ts` (`connectBrowser`, `disconnectBrowser`, drop the token field usage)
- Modify: `web/src/components/TopNav.tsx`
- Test: `web/test/api-client.test.ts`

**Interfaces:**
- Produces: `connectBrowser(): Promise<Principal>`, `disconnectBrowser(): Promise<void>`, `fetchPrincipal()` still used for status.

- [ ] **Step 1: Write the failing tests**

- `connectBrowser` POSTs `/api/connect` with `credentials: 'same-origin'` and no Authorization header.
- `disconnectBrowser` POSTs `/api/disconnect`.
- `sendMessage` no longer attaches an Authorization header from storage.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run web/test/api-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

On mount, `fetchPrincipal().catch(() => connectBrowser().catch(() => null))`; Settings shows `Connected as <name>` with **Disconnect**, or **Connect this browser** when unauthenticated. Remove the password input and the `getHumanToken`/`setHumanToken` usage from the send path.

- [ ] **Step 4: Test, typecheck, publish**

Run from `web/`: `npm run test`, `npx tsc -p tsconfig.json --noEmit`. Publish via the E: station: copy changed sources, `npm run build -w web`, `robocopy web\out F:\...\web\out /MIR`, refresh `/ui`.

- [ ] **Step 5: Commit (only on the human's word)**

---

### Task 4: Docs, full gate, review

**Files:** `README.md` (Settings section, trust note), `PROTOCOL.md` (agents unaffected - one line that browser sessions exist), spec status -> CURRENT after approval.

- [ ] **Step 1: Document** the auto-connect flow, the loopback refusal, and that agents still use Bearer tokens.
- [ ] **Step 2: Full gate** `npm test` + `npm run build -w server`; record counts.
- [ ] **Step 3: Restart and smoke** `/ui` 200, `/api/connect` 200, `/api/principal` with the cookie 200, Disconnect -> 401.
- [ ] **Step 4: Fresh review** of the delta, then report. Commit only on the human's word.
