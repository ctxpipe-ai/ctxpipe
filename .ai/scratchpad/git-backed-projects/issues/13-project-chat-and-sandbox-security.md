# Project chat, conversation state, and sandbox security

Type: grilling
Status: open
Blocked by: 01, 04, 05, 06, 08

## Question

Lock how **project chat** is powered, where conversation state lives, and how the isolated container is constrained.

The brief: TanStack AI on frontend **and** backend; backend sandbox runs OpenCode; sandbox is an isolated container all deployments support; scoped to the project repository; new conversations are named and listed under the Project; org-wide conversation list and source selector go away; top-level chat page moves onto the project page.

This ticket is **not** worktree create/commit/GC — that is [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md).

Settle:

- TanStack AI is the FE/BE transport; OpenCode is the agent inside the sandbox. Confirm or replace after research.
- Conversation transcripts: Postgres, TanStack storage, OpenCode session files, git knowledge tree, or a mix. Does "DB only updates from the project repo" apply to chat messages, or is chat **operational** state?
- Existing LangGraph conversations on migration: drop, export, or leave unread?
- Sandbox security: network policy, credentials (GitHub token? model keys?), resource limits, tenant isolation, untrusted repo content.
- MCP `ctx_advisor`: in scope, or leave in map fog?

Recommend: transcripts stay operational (not in the knowledge git tree) unless hydration requires them. Name the sandbox isolation you can actually ship on Compose, Railway, and Fargate.
