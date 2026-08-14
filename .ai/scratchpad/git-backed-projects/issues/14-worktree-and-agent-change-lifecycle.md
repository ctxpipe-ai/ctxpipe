# Worktree and agent-change lifecycle

Type: grilling
Status: open
Blocked by: 08, 09, 13, 17

## Question

Lock what the UI calls the chat workspace, and **what happens to the agent's writes**, now that chat isolation is a **TanStack sandbox working tree**, not a host `git worktree`.

Locked: [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md). `withSandbox` clones via `githubRepo` / `gitSource` (or `{ type: 'local', path }`) **into the sandbox**. Quick start: the agent does not touch the host filesystem. `lifecycle.reuse: 'thread'` is one sandbox per `threadId`. `dockerSandbox` snapshots after setup when the provider supports it.

The original brief's host worktree (lazy-on-first-write vs always-create) was the isolation mechanism we are **not** using for chat. Ingest staging worktrees remain [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md).

The file-edit *panel* is out of scope. Leaving sandbox writes with no disposition is not.

Settle:

- UI name: map TanStack `threadId` / sandbox instance to a friendly label (Claude/Codex/Cursor-like). Not a host worktree path.
- Do we still create a host git worktree for any chat reason (e.g. `{ type: 'local', path }` into the container), or is the in-sandbox clone enough?
- Disposition of writes **inside the sandbox**: commit/push to the project default branch, session branch, PR, keep uncommitted, discard when the sandbox is destroyed?
- Lifetime: `reuse: 'thread'` + `keepAlive` vs conversation delete vs Railway/Fargate idle timers.
- Crash recovery: TanStack resume/snapshot vs gone container.
- Who destroys sandboxes, and when.
- Collision with ingest: chat must not race ingest's one-commit-to-main rule.

Recommend: no host git worktree for chat; in-sandbox clone is the isolation. Default disposition: **do not commit to the Project's default branch from chat** unless the user says so. If you reject that, say what stops two conversations from racing ingest.

## Comments

### From [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md) round 2 (2026-08-14)

Human: the “force worktree” idea was isolation because a full checkout was assumed too slow. With TanStack cloning into an isolated sandbox, **do not use a host git worktree for chat isolation**. Ingest staging worktrees remain this ticket’s sibling [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md).

Measured: shallow clone of `ctxpipe-ai/ctxpipe` ~1 s; `kubernetes/kubernetes` depth-1 ~10 s / 419 MB. Workspace is backing-repo only, so kubernetes-scale is not the chat clone.

Round 3: human asked about `git worktree` + `{ type: 'local', path }`. TanStack bootstrap does not copy local trees into `dockerSandbox`; docker create has no bind mounts. Local path only helps `localProcessSandbox` (no isolation). Isolated providers still clone (or copy) into the sandbox.

Round 4: isolated chat uses the **git** workspace source. Reuse/start latency is a topology requirement (thread resume + snapshots); destroy/idle timers stay on this ticket.

**Locked by [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md):** git clone of backing repo; application-owned **project-level** snapshot/checkpoint then **fork per thread**; Postgres `SandboxInstanceStore` + cross-replica lock. This ticket still owns idle/destroy, Railway heartbeat (idle timer ignores in-VM processes), GC of bases, and whether restore discards thread writes.
