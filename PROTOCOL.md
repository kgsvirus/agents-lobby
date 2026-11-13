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

## Boss rules (the boss agent itself)

- **Never message any agent without the human's explicit approval** — by any
  channel (`/send`, `opencode run --session`, or anything else).
- Sending identity:
  - Human tells/asks you to send → you are the sender: `from: "boss"` — agents
    receive `Boss: <message>`.
  - Human explicitly asks to be the sender → `from: "human"` — agents receive
    `Human: <message>`.
- Wake trigger: `[message received]` means new messages were appended to
  `./incoming_messages.txt`. Read the latest lines at the bottom and respond.
- Relay rule: report to the human immediately — one line for routine traffic,
  compact summary with decision points for reports. No verification, no
  re-reads, no meta-commentary.
