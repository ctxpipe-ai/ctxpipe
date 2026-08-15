# Workspace chat, conversation state, and sandbox security

Type: grilling
Status: claimed
Blocked by: 01, 04, 05, 06, 08, 17

## Question

Lock how **workspace chat** is powered, where conversation state lives, and how the isolated container is constrained.

Already locked by [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md): client workspace chat is `chat()` + `withSandbox` + `opencodeText`; provider is TanStack's (`dockerSandbox` where a daemon exists). Do not re-open DIY `opencode serve`.

**Also locked by [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md):** **ops** agents (updating `AGENTS.md` on folder changes) use TanStack `chat()` **without** sandbox or harness. Do not put those jobs in a Docker sandbox. Do not reuse the client-chat `opencodeText` harness for them unless this ticket proves they need tools against the repo — the human said no sandbox/harness for that path.

The brief remainder: sandbox scoped to the project repository (TanStack `defineWorkspace` git source); new conversations named and listed under the Workspace; org-wide conversation list and source selector go away; top-level chat page moves onto the workspace page.

This ticket is **not** sandbox working-tree create/commit/GC — that is [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md).

Settle:

- Conversation transcripts: Postgres, `@tanstack/ai-persistence`, OpenCode's in-sandbox SQLite, git knowledge tree, or a mix. Does "DB only updates from the project repo" apply to chat messages, or is chat **operational** state?
- Existing LangGraph conversations on migration: drop, export, or leave unread?
- Sandbox security on top of TanStack policy: network, credentials (GitHub token? model keys?), resource limits, tenant isolation, untrusted repo content. `permissionMode` (`acceptEdits` vs `bypassPermissions`) is in play.
- MCP `ctx_advisor`: in scope, or leave in map fog?

Recommend: transcripts stay operational (not in the knowledge git tree) unless hydration requires them.

**Provider topology is locked** by [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md) — do not re-grill Compose DinD / Railway custom provider / Fargate v1 unsandboxed. This ticket still owns egress, `GH_TOKEN` refresh mid-run, `permissionMode`, tenant key in the sandbox id, and untrusted-repo policy.

**Read-only Workspace** ([Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md)): chat still runs; sandbox may dirty the clone; do **not** commit/push to the workspace remote. `permissionMode` while read-only is still this ticket if it differs from the writable default.

### Round 1 (asked, 2026-08-15)

Frontier: transcripts; legacy LangGraph rows; permissionMode; token refresh; egress/isolation; `ctx_advisor`. Do not re-grill TanStack path (17), providers (08), or unsandboxed ops (superseded by 10). Write disposition / idle GC stay [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md).
