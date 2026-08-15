# Workspace chat, conversation state, and sandbox security

Type: grilling
Status: resolved
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

**Hard denies first** (the judge **cannot** override): no App PEM, no `AUTH_SECRET`, no Contents:write, no commit/push to the workspace remote, no cloud-metadata, no hosts outside the v1 allowlist.

Then:

1. If `acceptEdits` would **allow** the call → allow (edits in the sandbox tree).
2. If `acceptEdits` would **reject** → a **fast / small model** (in code, not an operator env) judges whether the tool call is right and safe (Cursor/Claude/Codex auto-mode). Tiny context: tool name, short args excerpt, committed policy prompt. Allow or deny.
3. Timeout/garbage → **deny**.

**Broker** model and git credentials (backend / credential helper). Do not put raw long-lived keys in the sandbox. Short-lived `GH_TOKEN` via the helper stays as Q5.

Policy text and prompt live in committed code and may grow later — not an env feature flag.

**Read-only Workspace:** same handler. Chat may dirty the clone. No Contents:write token. No commit/push offer.

### Tokens and isolation

`GH_TOKEN`: read-only installation mint already locked on [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md) (workspace + linked GitHub remotes, max 500). Credential helper / `createSecrets` on resume **re-mints** before the 1h expiry. Do not restart the sandbox on rotate. Do not hash the token into `source.auth`. Never App PEM.

**Egress (v1):** allowlist GitHub for those remotes, **any workspace-repository host** (paste/GitLab/etc.), and model-provider hosts the adapter needs. Deny everything else (including cloud metadata) — hard deny, not judgeable. Codesearch stays on the backend — no Zoekt path from the sandbox. **Broker** model keys and git auth (no raw long-lived keys in the sandbox). Never `AUTH_SECRET` / App PEM. Sandbox id includes **org id + `ws_`** plus the locked URL/SHA/image key. Do not unsandbox “trusted” customer repos. **Chat sandbox size (small pod, mostly LLM I/O):** 1 vCPU, 1 GiB RAM, 128 PIDs, 4 GiB writable disk. Non-root. No privileged or device mounts. Isolated provider that cannot enforce equivalent-or-stricter → **fail closed**. Fargate v1 remains the unsandboxed exception. Not a compile box — retrieval and model calls are brokered. Write-sandbox sizing stays [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md) / [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md). **Later:** tighter operator/user control of this allowlist — not this version.

### MCP `ctx_advisor`

**Deprecated.** No org-wide advisor. No `workspace.id` argument. Compatibility shim: the **same Workspace chat** (`chat()` + `withSandbox` + `opencodeText`, same permission policy, same retrieval tools) against the **first** Workspace — persisted first-Workspace id from [First-workspace migration and idempotent cutover](12-first-project-migration.md), else earliest `ws_` `created_at` then `id`. **One new persisted MCP-origin conversation per invocation** — no hidden cross-call memory, no new MCP arguments, not the UI thread. **Exclude MCP-origin rows from the normal Workspace conversation list.** Zero Workspaces → fail (create empty state); do not fall back to org-wide retrieval. Conversation-source selector stays gone. Fine-grained MCP tools replace this later. **Delete** the legacy LangGraph retrieval-advisor loop.

### Retrieval tools on Workspace chat

Workspace chat (UI and the deprecated MCP shim) must be able to **read** the same stores today’s advisor does, scoped to this Workspace’s **active** projection ([Workspace revision and derived-store freshness](11-project-revision-and-freshness.md)):

- **Postgres** knowledge / claims (today’s hybrid-search / claim reads)
- **FalkorDB** graph tools (`graph_find_symbol`, `graph_get_callers`, `graph_get_callees`, …)
- **Codesearch** (Zoekt / SCIP: `search`, `glob_files`, `get_file`, `find_symbol_*`, `structural_search`, `list_repositories` for this Workspace’s set)

These tools run on the **backend** TanStack bridge ([Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md)). The sandbox does not get `DATABASE_URL`, Falkor credentials, or a private path to Zoekt. They are read tools; writes to git still go through the permission handler + [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md).

### Sol (2026-08-15) — do not close (second pass)

Q8 runtime is locked. Remaining: MCP thread/memory per invocation; whether the LLM judge can override security denies / raw creds in the sandbox.

### Round 3 (asked, 2026-08-15)

Sol refused close. Remaining: `ctx_advisor` conversation identity; deterministic security denies vs the judge.

### Round 3 (human, 2026-08-15)

- **Q9:** One new persisted MCP-origin conversation per invocation. No cross-call memory. UI threads stay separate.
- **Q10:** Deterministic security denies the judge cannot override. Broker model/git credentials; no raw long-lived keys in the sandbox.

### Sol (2026-08-15) — do not close (third pass)

Q9/Q10 accepted. Remaining: whether MCP-origin conversations appear in the Workspace UI list.

### Round 4 (asked, 2026-08-15)

Sol refused close. Remaining: MCP conversation visibility in the UI list.

### Round 4 (human, 2026-08-15)

- **Q11:** Persist MCP-origin conversations; **exclude** them from the normal Workspace UI list.

### Sol (2026-08-15) — do not close (fourth pass)

Q11 accepted. Remaining: concrete sandbox resource limits (not “in code”).

### Round 5 (asked, 2026-08-15)

Sol refused close. Remaining: CPU / RAM / PID / disk / privilege limits.

### Round 5 (human, 2026-08-15)

- **Q12:** Smaller than 2 vCPU / 4 GiB. Chat sandboxes are small pods that mostly call the LLM, not compute-heavy. Locked: **1 vCPU, 1 GiB RAM, 128 PIDs, 4 GiB disk**; non-root; no privileged/device mounts; fail closed if an isolated provider cannot enforce that.

### Sol (2026-08-15) — close

Passes 1–4 **revise**; fifth pass **accept** after small-pod limits. No further product forks.

### Round 2 (human, 2026-08-15)

- **Q8:** Same runtime as Workspace chat (not the old retrieval graph). Workspace chat **must** expose today’s retrieval tools (Postgres / Falkor / codesearch), Workspace-scoped.
