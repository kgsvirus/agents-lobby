# Dashboard auto-connect (loopback session) - design

**Status: IMPLEMENTED (2026-11-19).** Review closed; the code, tests and
dashboard carry this design. Remaining step: the human's commit.

Audience: Agents-Lobby maintainers and implementers.

## Problem

The dashboard's send path needs the human principal. Today that means pasting
the human token from `.data/peer-auth.json` into Settings and pressing Connect.
It is real work for the only person who uses the UI, and the token is then held
in `sessionStorage` where page JavaScript (and any XSS) can read it.

## Which modes the feature exists in

The lobby has three credential modes (`routes.ts` guard selection). The paste
problem only exists in one of them, so the feature is scoped to that one:

| Mode (how it is detected) | `/api/connect` | Dashboard behaviour |
|---|---|---|
| **Identity** - `config/peerAuth` present | enabled | auto-connect as `human` |
| **Shared token** - `config.authToken` present, no principals | **refused (403 `auth_mode_shared_token`)** | token paste stays (hidden unless this mode) |
| **Open** - neither | **refused (403 `auth_mode_open`)** | no Connect UI; sends stay as today |

Reason: in open mode a cookie principal would flip `/send` into `authenticated:
true`, which enforces a policy file a fresh clone does not have - every
dashboard send would 403. In shared-token mode a cookie would bypass the
operator's shared secret, and the paste field is the only browser path that
satisfies it.

`GET /api/auth-mode` returns `{mode}` so the dashboard shows the right UI
without guessing.

## What changes

A browser on the same machine authenticates as `human` through an HttpOnly
session cookie the server mints on request. Agents keep bearer tokens,
unchanged.

- `POST /api/connect` - identity mode and loopback callers only. Mints a random
  session id, stores `{name: 'human', kind: 'human'}` in an in-memory session
  map, and sets `lobby_session=<id>` with
  `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`. Returns the principal.
- `POST /api/disconnect` - deletes the session and clears the cookie;
  idempotent 200 even with no/invalid cookie (a reload after restart must not
  show an error).
- `/send`, `/prompt` and `/api/principal` accept either credential:
  `Authorization: Bearer <token>` or the session cookie. **If an
  `Authorization` header is present and invalid, the request is 401 - it never
  falls back to the cookie** (a revoked agent token must not become `human`).
- The dashboard asks `/api/auth-mode`, then connects on load in identity mode,
  so there is no paste. Settings shows "Connected as human - this browser" and
  a Disconnect button; Disconnect is sticky for the tab (an opted-out flag in
  `sessionStorage`, so a reload does not sign the browser back in).

## Refusals and limits

- Loopback means the peer address is `127.0.0.1`, `::1` or `::ffff:127.0.0.1`
  (dual-stack binds present the last form). `config.host` must be a loopback
  bind or `localhost`; `0.0.0.0` and `::` are refused.
- `X-Forwarded-For` is never consulted (Fastify `trustProxy` is off and the
  check uses the raw socket), and a test pins that.
- Sessions live in memory and are pruned on create (`Max-Age` + a small
  expiry sweep); a server restart signs every browser out. An already-open tab
  whose cookie died gets one automatic reconnect-and-retry on 401, so a restart
  does not leave the page stuck.
- **Minting CSRF** is blocked by two things a cross-site page cannot produce:
  the `x-lobby-connect` header (forms cannot set headers) and the JSON content
  type on the request. `SameSite=Strict` then keeps the cookie off cross-site
  requests. Because a CSRF guard that is described wrongly is worse than none,
  this is the actual mechanism, not SameSite alone.
- **Proxy and rebinding guards:** `/api/connect` and `/api/disconnect` refuse
  any request carrying `x-forwarded-for`, `forwarded` or `x-real-ip` (a proxy
  would make every remote visitor look local), and require the `Host` hostname
  to be `127.0.0.1`, `localhost` or `::1` (a DNS-rebinding page on another name
  must not be same-origin with the lobby).
- Connecting rotates the browser's previous session id; Disconnect deletes the
  presented one. Sessions are in memory and pruned on create.
- The cookie is never logged: `req.headers.cookie` joins `authorization` in the
  redaction list, exported so a test can assert the real value.

## Trust statement (unchanged, restated honestly)

This does not make the lobby more secure. Any process running as **this OS
user** can read `.data/peer-auth.json`, so "loopback = human" is the same trust
level for that user, expressed with less friction. It is *not* equivalent for
other OS users on a multi-user machine: loopback is machine-wide and a cookie
needs no filesystem read. What improves: the secret no longer sits in
`sessionStorage`, a browser session can be revoked by Disconnect or a restart,
and the audit row still names `human`.

## Non-goals

- No multi-user accounts, no passwords, no roles for browsers.
- No change to agent tokens, the role policy, or the wake boundary.
- No HTTPS/cookie hardening beyond what loopback needs.

## Verification focus

- `/api/connect` in identity mode, loopback: returns a principal and sets an
  `HttpOnly` cookie; `GET /api/principal` then answers with no header.
- `/api/connect` refused 403 in open mode and in shared-token mode, with no
  cookie set.
- Peer address matrix: `127.0.0.1`, `::1` and `::ffff:127.0.0.1` accepted;
  `203.0.113.7` refused **even with `x-forwarded-for: 127.0.0.1`**.
- `config.host` matrix: `127.0.0.1` and `localhost` accepted; `0.0.0.0` and
  `::` refused.
- `/send` with the cookie only acts as `human`; a cookie holder cannot become
  `boss` or an agent.
- An invalid `Authorization` header with a valid cookie is 401, not `human`.
- `POST /api/disconnect` clears session and cookie; the old cookie is rejected
  by `/send`, not just ignored by the browser. Disconnect with no cookie is a
  200.
- Two browsers: disconnecting one leaves the other working.
- Restart: an old session id is rejected (empty in-memory map).
- The cookie value never appears in logs.
- The dashboard connects on load in identity mode without a paste; in
  shared-token mode it shows the token field; Disconnect is sticky for the tab.
