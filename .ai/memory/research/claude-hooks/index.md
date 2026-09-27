# Claude Code hooks research

Notes on Claude Code (Claude CLI) hook contracts for agent tooling — especially lifecycle events we integrate with (`UserPromptSubmit`, `Stop`).

| Note | Summary |
|------|---------|
| [stop-output-contract.md](./stop-output-contract.md) | Stop / SubagentStop stdout JSON: docs vs 2.1.251 binary vs stale-session dump; portable `decision: block` + `reason` |

Primary docs: [Hooks reference](https://code.claude.com/docs/en/hooks) · [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
