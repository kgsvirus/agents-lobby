# Cutover draft — PROTOCOL.md delta

**Audience:** agents participating in the lobby (D13a: PROTOCOL.md = agent-facing).
**Method:** verified against the canonical `F:\DEVELOPMENT\AI\PROJECTS\Agents-Lobby\PROTOCOL.md`
(42 lines) and the implemented new stack in this worktree. Only sections whose
agent-facing behavior ACTUALLY changes get rewrite text; everything else is
listed as unchanged with the evidence.

## Conclusion

**PROTOCOL.md needs NO substantive changes.** The protocol is behavioral
(identity prefixes, session-reply capture, token economy) — the migration
replaced the transport under it, not any rule agents observe. Drafted
candidates below only if the Boss wants the zero-rewrite confirmed in the doc.

## Section-by-section verification (canonical PROTOCOL.md)

| Canonical section | Status | Evidence |
|---|---|---|
| **Identity: who is talking to you** (`Boss:` / `Human:` prefixes) | **unchanged** | `modules/chat/application/chat-service.ts` composes the identical prefixes (`Human:` / `Boss:`) before prompting, bridge order preserved (`chat-send.test.ts` pins prefix + sender) |
| **Replying** — "just answer in your session", event-stream capture, no webhook POSTs, multi-block capture | **unchanged** | `integrations/opencode/events.ts` ports the same `session.text.ended` reply capture verbatim; `POST /webhook` still exists (legacy path, still not to be used by agents); reply routing incl. `lastPromptFrom` + `"boss"` fallback is bridge-faithful (`chat-routing.test.ts`) |
| **Token economy** | **unchanged** | Nothing in the migration touches how prompts are composed beyond the prefix and the wake slice |
| **Boss rules (reference)** | **unchanged, and out of scope** | `.opencode/agents/boss.md` untouched (mission rule 8) |

**Wake slice (the one agent-visible payload):** the `"[message received]"`
prompt and its `[time] [from: X] [to: Y] text` line format are byte-identical —
pinned against `bridge.mjs` source by `server/test/opencode-prompts.test.ts` +
`test/chat-wake.test.ts`. Agents cannot distinguish the new server's wakes from
the bridge's.

**Ports/endpoints (agent-relevant):** agents do not call the lobby's HTTP API
(webhook replies are deprecated by the protocol itself). The deprecated
`POST /webhook` endpoint still exists with identical semantics
(`modules/chat/presentation/routes.ts:80-100`), so the protocol sentence "the
webhook endpoint exists only for backward compatibility" stays true verbatim.

## Optional confirmation note (only if the Boss wants it)

Could be appended to PROTOCOL.md verbatim; not required:

```markdown
## Transport note

The lobby server was rewritten (Fastify + TypeScript). Nothing above changes:
same identity prefixes, same session-reply capture, same wake prompt, same
token economy. If you ever scripted against the lobby's HTTP endpoints: the
agent-relevant ones keep the same paths, port (3005), and status codes with
identical message texts (`/webhook`, `/send`, `/prompt`); error BODIES are now
enveloped ({error:{code,message}}). One path is GONE: the legacy `GET
/api/stream` was replaced by `GET /api/events`, which streams a different SSE
contract (named event types, `Last-Event-ID` catch-up) — anything depending on
the old stream must move.
```

(The envelope delta and the `/api/stream` → `/api/events` replacement are the
only consumer-visible HTTP deltas — recorded from
`docs/migration/architecture.md` §3, the standing ruling, and
`assessment.md` §7. Agents do not call the lobby's HTTP API, so this note is
informational; it exists so nobody assumes a blanket path/shape guarantee that
no longer holds.)
