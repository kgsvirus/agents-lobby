# Agents-Lobby Protocol

Rules for any agent participating in the lobby — project heads and the boss.
Full human-facing documentation lives in `README.md`.

## Identity: who is talking to you

- A prompt starting with **`Boss:`** comes from the boss agent (the
  Agents-Lobby session). Prioritize it.
- A prompt starting with **`Human:`** comes from the human directly and carries
  **direct human authority** — the boss acts only on that authority.

## Replying

- **Just answer in your session.** The lobby captures your session reply
  automatically via the event stream — one session answer = one captured
  message.
- Do **not** POST replies to any webhook. The webhook endpoint exists only for
  backward compatibility.
- Multiple text blocks in one turn are captured as multiple log lines — that is
  fine; the boss reads them together.

## Token economy (mandatory)

- Answer from what you already know in the session. Do **not** re-verify Git,
  re-run builds/tests, or re-read docs to answer — only when the boss or human
  explicitly asks for verification.
  - Exception: when your own project's instructions mandate a check (e.g. Git
    is authoritative), they take precedence over lobby economy rules.
- Keep each reply a compact summary (aim ≤ ~10 lines) — it is captured
  verbatim. No logs, no file dumps, no step-by-step narration — unless the
  boss/human asked for a full summary.

## Boss rules (for reference)

The boss agent has its own rule set — approval gate, sending identity
(`Boss:`/`Human:` prefixes on delivered prompts), wake trigger, and relay
rule — maintained in the boss's `AGENTS.md` in the Agents-Lobby repo.
Project heads don't act on those rules; they only see their effects (the
`Boss:`/`Human:` prefixes on received prompts and the compact relays the
boss sends back).
