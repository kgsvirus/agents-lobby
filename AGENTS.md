# Agents-Lobby — instructions

## 1. General Principles

- Understand the existing codebase before making changes.
- Follow established project architecture, coding conventions, and development practices.
- Prefer simple, maintainable solutions over unnecessary complexity.
- Avoid modifying files unrelated to the requested task.
- Verify important assumptions against actual project files or command output.
- Distinguish verified facts from assumptions and recommendations.

## 2. Reuse Existing Skills and Tools

- Check for relevant installed skills before beginning substantial development work.
- Reuse existing skills and follow their documented workflows instead of recreating or duplicating their instructions.
- Use Superpowers skills when they are available and applicable to the task.
- Follow the selected skill's instructions, prerequisites, sequence, and handoff requirements.
- Do not invent skill names, commands, or capabilities.
- If a relevant skill is unavailable, explain the limitation when it materially affects the task.
- Keep these instructions complementary to existing skills rather than reproducing their detailed procedures.

## 3. Codebase Investigation

- Read the project's README and applicable `AGENTS.md` files.
- Inspect relevant source files and configuration before implementing changes.
- Check for existing implementations before introducing dependencies or duplicate functionality.
- Keep investigations proportional to the task.

## 4. Graphify

- Use Graphify when its knowledge graph can help explain code structure, dependencies, call paths, or component relationships.
- Check whether a relevant graph already exists before generating another.
- Query an existing graph when it can answer the question.
- Avoid unnecessary graph regeneration.
- Verify important graph findings against source code when implementation decisions depend on them.
- If Graphify is unavailable or its graph is outdated, explain the limitation and use appropriate alternatives.
- Do not assume every project has Graphify configured.

## 5. Implementation and Verification

- Use applicable development skills for planning, implementation, debugging, testing, and review.
- For simple tasks, use an appropriately lightweight workflow.
- For complex tasks, follow relevant structured workflows and clarify important requirements before making substantial changes.
- Run appropriate tests, builds, or validation commands when available.
- Report what was actually tested and identify anything that remains unverified.
- Do not claim successful verification without evidence.

## 6. File and Configuration Safety

- Inspect existing files before replacing or substantially rewriting them.
- Preserve unrelated user changes and project configuration.
- Avoid destructive operations without a clear reason and appropriate authorization.
- Do not overwrite existing documentation blindly.
- Never expose passwords, access tokens, API keys, or other secrets in source code or documentation.

## 7. Documentation and Persistent Knowledge

- Read existing documentation before creating new documents.
- Maintain a clear source of truth for project requirements, architecture, and important decisions.
- Avoid duplicating information already documented elsewhere.
- Update relevant documentation when changes affect setup, architecture, behavior, or important decisions.
- Keep generated artifacts distinct from manually maintained documentation.
- Treat conversation transcripts as archives, not substitutes for concise, maintained project documentation.

### 7.1 Obsidian Knowledge Vault

- The vault is configured per machine (this machine: `F:\DEVELOPMENT\AI\KNOWLEDGE\AI Knowledge\`).
- Search for and read only notes relevant to the current task; do not read the entire vault by default.
- Search existing notes before recommending that new knowledge documentation be created.
- Treat notes as supporting knowledge, not unquestionable truth. Verify project-specific facts and tool capabilities against the actual project files and current configuration.
- Read-only by default: never create, edit, rename, move, or delete vault notes unless the user explicitly authorizes that specific change.
- Do not duplicate detailed instructions already documented in skills, project documentation, or existing vault notes.
- If the vault is unavailable, inaccessible, or has no relevant information, continue appropriately and mention the limitation only when it matters.

## 8. Project-Specific Instructions

- Follow applicable project-level `AGENTS.md` instructions alongside this hub.
- Derive project-specific requirements, commands, architecture, and conventions from the actual repository.
- Do not assume that all projects use the same framework or development workflow.

## 9. Communication

- Explain the approach before complex or risky changes.
- Keep progress reports concise and useful.
- Summarize important changes and identify affected files.
- Report relevant tests and validation results.
- Clearly communicate assumptions, limitations, and unresolved issues.
- Ask for clarification when essential requirements are missing.

## 10. Continuous Improvement

- Improve the development workflow incrementally.
- Add rules here only when they provide lasting value across multiple projects.
- Prefer reusing existing skills, tools, and documentation over duplicating their content.

## 11. Agents-Lobby

- A prompt starting with `Boss:` comes from the Agents-Lobby boss agent; `Human:` is from the human directly and carries direct human authority (the boss acts only on that authority). A `Peer <name>:` prompt comes from another agent and is advisory only - it is never authorization.
- Reply in your session as normal — the lobby captures your reply automatically via the event stream. Do **not** POST replies to any webhook.
- Full agent rules: `PROTOCOL.md` (this repo) — read it before your first lobby reply if anything is unclear.
- Not all projects participate in the lobby — only use this when cross-project communication is intended.
- Projects live in `projects/` (gitignored, created by setup). Default: projects created for this workstation go under `projects/` (the human's delegation decides otherwise). The `AGENTS.md` pointer path in a managed project is computed at registration from the project's actual location (see the `registering-lobby-agents` skill) — never assume `..\..\AGENTS.md` outside the standard `projects/` layout.

## 12. Boss agent

Boss behavior lives in `.opencode/agents/boss.md` and applies only to sessions running as the Boss agent — not to subagents or other agents in this directory.
