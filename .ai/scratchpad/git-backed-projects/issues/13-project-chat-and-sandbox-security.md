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

### Round 1 (human, 2026-08-15)

- **Q1:** Operational Postgres (`workspace_id` on `conversations`). Not git. Not OpenCode SQLite. `threadId` = conversation id.
- **Q2:** **Drop** LangGraph conversations. No export into `knowledge/`.
- **Q3:** Custom `onPermissionRequest`: mirror **`acceptEdits`** for what that mode would allow; for would-be rejects, a **fast LLM judge** (Claude/Codex/Cursor auto-mode). Policy + prompt are extendable later. Not `bypassPermissions`.
- **Q4:** **Same policy as Q3** on read-only Workspaces. Still no commit/push / write token ([Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md)).
- **Q5:** Credential helper re-mints before expiry. No sandbox restart. No App PEM / Contents:write in the chat sandbox.
- **Q6:** Allowlist as recommended **plus any workspace-repository host**. More user control later — not v1.
- **Q7:** `ctx_advisor` is **deprecated**. Compatibility: default to the **first** Workspace. No `workspace.id` argument. No org-wide advisor. Source selector stays gone. Fine-grained MCP tools later.

## Answer

Human lock, 2026-08-15. Product chat stays `chat()` + `withSandbox` + `opencodeText` ([Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md)). Providers stay [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md). Ops is a write-path **job** ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)) — the unsandboxed-ops line in this ticket’s question is stale. Dirty-tree disposition and idle/GC: [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md).

### Transcripts

Chat is **operational**. Postgres `conversations` gains `workspace_id`; messages (TanStack persistence **over** that Postgres is fine) are the source of truth. Not the workspace git tree. Not OpenCode SQLite. `threadId` = conversation id. List and name conversations under that Workspace.

**Legacy LangGraph** rows and checkpoints: **drop**. Do not migrate, do not show as unread, do not export into `knowledge/`.

### Permission policy

Do **not** use `bypassPermissions`. Implement `onPermissionRequest`:

1. If `acceptEdits` would **allow** the call → allow (edits in the sandbox tree).
2. If `acceptEdits` would **reject** → a **fast / small model** (in code, not an operator env) judges whether the tool call is right and safe (Cursor/Claude/Codex auto-mode). Tiny context: tool name, short args excerpt, committed policy prompt. Allow or deny.
3. Timeout/garbage → **deny**.
4. The judge **cannot** mint a write token or authorize commit/push to the workspace remote. That stays [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md) / read-only rules.

Policy text and prompt live in committed code and may grow later — not an env feature flag.

**Read-only Workspace:** same handler. Chat may dirty the clone. No Contents:write token. No commit/push offer.

### Tokens and isolation

`GH_TOKEN`: read-only installation mint already locked on [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md) (workspace + linked GitHub remotes, max 500). Credential helper / `createSecrets` on resume **re-mints** before the 1h expiry. Do not restart the sandbox on rotate. Do not hash the token into `source.auth`. Never App PEM.

**Egress (v1):** allowlist GitHub for those remotes, **any workspace-repository host** (paste/GitLab/etc.), and model-provider hosts the adapter needs. Deny everything else (including cloud metadata). Codesearch stays on the backend — no Zoekt path from the sandbox. Model keys as secrets, not in the clone; never `AUTH_SECRET` / App PEM. Sandbox id includes **org id + `ws_`** plus the locked URL/SHA/image key. Do not unsandbox “trusted” customer repos. Resource limits in code. Fargate v1 remains the unsandboxed exception. **Later:** tighter operator/user control of this allowlist — not this version.

### MCP `ctx_advisor`

**Deprecated.** No org-wide advisor. No `workspace.id` argument. Compatibility shim: run the **same Workspace chat** (same transcripts, same permission policy) against the **first** Workspace — persisted first-Workspace id from [First-workspace migration and idempotent cutover](12-first-project-migration.md), else earliest `ws_` `created_at` then `id`. Zero Workspaces → fail (create empty state); do not fall back to org-wide retrieval. Conversation-source selector stays gone. Fine-grained MCP tools replace this later.
