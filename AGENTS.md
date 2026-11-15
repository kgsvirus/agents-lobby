# Agents-Lobby — project facts

- Projects live in `projects/` (gitignored, created by setup.mjs).
  Default: projects created for this workstation go under `projects/`,
  then get registered via the `registering-lobby-agents` skill if they
  join the lobby. The human's delegation decides otherwise — if the
  human names a different location, that wins.
- Lobby communication rules (any project-head session): `PROTOCOL.md`.
- Boss behavior lives in `.opencode/agents/boss.md` and applies only
  to sessions running as the Boss agent — not to subagents or other
  agents in this directory.
