# Project chat, conversation state, and sandbox security

Type: grilling
Status: open
Blocked by: 01, 04, 05, 06, 08, 17

## Question

Lock how **project chat** is powered, where conversation state lives, and how the isolated container is constrained.

Already locked by [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md): `chat()` + `withSandbox` + `opencodeText`; provider is TanStack's (`dockerSandbox` where a daemon exists). Do not re-open DIY `opencode serve`.

The brief remainder: sandbox scoped to the project repository (TanStack `defineWorkspace` git source); new conversations named and listed under the Project; org-wide conversation list and source selector go away; top-level chat page moves onto the project page.

This ticket is **not** sandbox working-tree create/commit/GC — that is [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md).

Settle:

- Conversation transcripts: Postgres, `@tanstack/ai-persistence`, OpenCode's in-sandbox SQLite, git knowledge tree, or a mix. Does "DB only updates from the project repo" apply to chat messages, or is chat **operational** state?
- Existing LangGraph conversations on migration: drop, export, or leave unread?
- Sandbox security on top of TanStack policy: network, credentials (GitHub token? model keys?), resource limits, tenant isolation, untrusted repo content. `permissionMode` (`acceptEdits` vs `bypassPermissions`) is in play.
- MCP `ctx_advisor`: in scope, or leave in map fog?

Recommend: transcripts stay operational (not in the knowledge git tree) unless hydration requires them. Name the TanStack **provider** you can actually ship on Compose, Railway, and Fargate (that may defer to [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md)).
