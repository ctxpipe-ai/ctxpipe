# ADR-055: Harness-agnostic agent setup

**Status:** Accepted | **Date:** 2026-10-24 | **Tags:** agents, tooling, mcp, skills, codex, claude-code

## Context

The team builds with coding agents. It used Cursor first, so the shared agent files lived under `.cursor/`, and `.agents/` was a symlink to it. The team then moved to Claude Code as the primary harness and Codex as a second model family. An orchestrator app starts the agents in each harness. Each harness reads its own config directory, but the skills, the hooks, and the instructions must stay the same for all of them. Codex reads only the first 32 KiB of the `AGENTS.md` files on its path.

## Decision

1. **`.agents/` holds the shared agent content.** Skills are in `.agents/skills/`, and hooks are in `.agents/hooks/`. It is a real directory, not a link to the folder of one harness.
2. **`AGENTS.md` is the one instruction file.** Each harness reads it. A nested `AGENTS.md` holds the rules of one app or package. The root file stays within 24 KiB, so that the root and a nested file stay within the Codex limit together. Text that only some tasks need goes to a document behind a pointer.
3. **Each harness directory is a thin adapter.** `.claude/`, `.codex/`, `.cursor/`, and `opencode.json` hold only the settings of their harness: hook wiring, MCP servers, and a symlink to `.agents/skills`. They hold no shared rule or skill.
4. **The MCP server lists stay in parity.** The Claude Code, Codex, and Cursor configs list the same servers with the same URLs. Each harness can use its own way to send a key. A CI check enforces the parity, the size limits, and the skill symlinks.
5. **Cursor stays dormant.** Its files stay in the repository and in the parity check, so the team can use Cursor again with no new setup.

## Consequences

- A new skill or hook goes into `.agents/` once, and every harness gets it.
- A new MCP server goes into each harness config in the same change, or CI fails.
- A new harness needs only an adapter that points at `AGENTS.md` and `.agents/`.
- The size limit pushes long or rare instructions into documents behind pointers, such as the remote environment guide in `.ai/agents/`.

## Alternatives considered

- **Keep `.cursor/` as the home and link the others to it.** The shared content would depend on a harness that the team no longer uses.
- **One instruction file per harness (`CLAUDE.md` and others).** The copies would drift, and each rule would need more than one edit.
- **Generate each harness config from one source file.** It adds a build step for a small number of files; a check is enough to stop drift.
