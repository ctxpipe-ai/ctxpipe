# Worktree and agent-change lifecycle

Type: grilling
Status: claimed
Blocked by: 08, 09, 13, 17

## Question

Lock what the UI calls the chat workspace, and **what happens to the agent's writes**, now that chat isolation is a **TanStack sandbox working tree**, not a host `git worktree`.

Locked: [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md). `withSandbox` clones via `githubRepo` / `gitSource` (or `{ type: 'local', path }`) **into the sandbox**. Quick start: the agent does not touch the host filesystem. `lifecycle.reuse: 'thread'` is one sandbox per `threadId`. `dockerSandbox` snapshots after setup when the provider supports it.

The original brief's host worktree (lazy-on-first-write vs always-create) was the isolation mechanism we are **not** using for chat. Ingest staging is an **in-sandbox `git worktree`** on the Workspace **write sandbox** — [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md). This ticket still owns idle/destroy/GC of chat **and** write sandboxes.

The file-edit *panel* is out of scope. Leaving sandbox writes with no disposition is not.

Settle:

- UI name: map TanStack `threadId` / sandbox instance to a friendly label (Claude/Codex/Cursor-like). Not a host worktree path.
- Do we still create a host git worktree for any chat reason (e.g. `{ type: 'local', path }` into the container), or is the in-sandbox clone enough?
- Disposition of writes **inside the sandbox**: commit/push to the project default branch, session branch, PR, keep uncommitted, discard when the sandbox is destroyed?
- Lifetime: `reuse: 'thread'` + `keepAlive` vs conversation delete vs Railway/Fargate idle timers.
- Crash recovery: TanStack resume/snapshot vs gone container.
- Who destroys sandboxes, and when.
- Collision with ingest: chat must not race ingest's one-commit-to-main rule.

Recommend: no host git worktree for chat; in-sandbox clone is the isolation. Default disposition: **do not commit to the Workspace's default branch from chat** unless the user says so. If you reject that, say what stops two conversations from racing ingest.

## Comments

### From [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md) round 2 (2026-08-14)

Human: the “force worktree” idea was isolation because a full checkout was assumed too slow. With TanStack cloning into an isolated sandbox, **do not use a host git worktree for chat isolation**. Ingest staging worktrees remain this ticket’s sibling [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md).

Measured: shallow clone of `ctxpipe-ai/ctxpipe` ~1 s; `kubernetes/kubernetes` depth-1 ~10 s / 419 MB. Workspace clone is workspace-repository only, so kubernetes-scale is not the chat clone.

Round 3: human asked about `git worktree` + `{ type: 'local', path }`. TanStack bootstrap does not copy local trees into `dockerSandbox`; docker create has no bind mounts. Local path only helps `localProcessSandbox` (no isolation). Isolated providers still clone (or copy) into the sandbox.

Round 4: isolated chat uses the **git** workspace source. Reuse/start latency is a topology requirement (thread resume + snapshots); destroy/idle timers stay on this ticket.

**Locked by [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md):** git clone of workspace repository; application-owned **workspace-level** snapshot/checkpoint then **fork per thread**; Postgres `SandboxInstanceStore` + cross-replica lock. This ticket still owns idle/destroy, Railway heartbeat (idle timer ignores in-VM processes), GC of bases, and whether restore discards thread writes.

**Locked by [Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md):** while the Workspace is read-only, chat may dirty the in-sandbox clone; **commit/push to the workspace remote is refused**. Relink invalidates snapshot keys (desired URL + stored SHA). Disposition of those dirty trees (keep, discard, push once writable) is this ticket.

### Round 1 (asked, 2026-08-15)

Frontier: UI label; chat write disposition vs ticket 13 hard deny; idle/destroy/GC; crash; write-sandbox lifetime and size. Host worktree for chat isolation is already refused (08).

### Round 1 (human, 2026-08-15)

- **Q1:** Conversation name is the UI label. Default from first user message; user can rename. No worktree path / raw `threadId`.
- **Q2:** Chat **may** create a **branch + PR** on the workspace repository. Chat **must not** push the default branch. Only **predefined jobs** push default ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)).
- **Q3:** 30 minutes after last turn; heartbeat during a turn; delete destroys; next message forks a fresh tree.
- **Q4:** Resume snapshot if the provider still has it; if the container is gone, uncommitted writes are lost. Transcripts survive. No rescue commit.
- **Q5:** Accept idle/GC, but the shared sandbox is a **job sandbox**, not “the write sandbox.” Any sandbox can write, with different restrictions.
- **Q6:** Job sandbox is the **same size as chat**: 1 vCPU, 1 GiB RAM, 128 PIDs, 4 GiB disk.

## Answer

Human lock, 2026-08-15. No host git worktree for chat isolation ([Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md)). File-edit panel remains out of scope.

**Vocabulary:** **Job sandbox** (one per Workspace, jobs + in-sandbox worktrees) vs **chat sandbox** (`withSandbox` per `threadId`). Retired: “write sandbox.” Any sandbox may write; **who may push the default branch** is the restriction.

### UI

The human-facing name is the **conversation name** ([Workspace chat, conversation state, and sandbox security](13-project-chat-and-sandbox-security.md)). Default: truncated first user message. User may rename. Never a host path or raw `threadId`.

### Who may write what

| Actor | Default branch | Branch + PR | Token in sandbox |
| --- | --- | --- | --- |
| **Predefined jobs** | Yes — runner pushes ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)) | No (not their path) | No push creds; runner is outside |
| **Workspace chat** | **Never** | **Yes** (GitHub v1) | No push creds; **backend/runner** creates the branch + PR from the sandbox tree |
| **Read-only Workspace** | No | No | Unchanged ([Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md)) |

This **narrows** [Workspace chat, conversation state, and sandbox security](13-project-chat-and-sandbox-security.md): the hard deny is **no push to the default branch** (and no Contents:write / App PEM in the sandbox). Branch+PR is allowed and **brokered** — `gh` in the sandbox stays read-only ([Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md)).

Dirtiness alone **never** creates GitHub state. Only an **explicit** brokered request (agent/user: open or update a PR) creates a branch + PR.

A conversation may open **multiple** PRs (no one-PR cap, no “start a new conversation after merge”). Branch names are a code constant (`ctxpipe/chat/<conversationId>/<n>`). Runner pushes that **session** branch (force-with-lease on that branch only). **Never** force-push the default branch. Relink: do not push a PR to the old URL (generation recheck); the same conversation may publish to the new desired remote. Conversation delete destroys the sandbox and does **not** close or delete existing GitHub PRs/branches. Non-GitHub workspace remotes: chat stays dirty-tree only (v1 writes are GitHub-only).

Uncommitted edits that never become a PR: **discard** when the chat sandbox is destroyed (idle/delete/crash-without-snapshot).

Jobs still cannot use “open a PR because main is protected” ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)). Chat PRs are a different path and do not race job fast-forwards on default.

### Chat lifetime

`reuse: 'thread'` + workspace-base fork stay ([Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md)). Keep the chat sandbox while the conversation exists **and** last turn was within **30 minutes** (code constant). Conversation delete → destroy now. **Heartbeat** the provider during a turn (Railway idle ignores in-VM processes).

**Fresh data is the default.** When desired SHA advances (a job pushed), **quietly update** the live chat tree onto the new base: clean tree → reset; dirty tree → rebase onto the new SHA if it applies. If rebase cannot apply, **reset to fresh** (lose conflicting uncommitted) so the agent is not stuck on stale default. Rotate workspace bases for *new* forks the same way ([Workspace revision and derived-store freshness](11-project-revision-and-freshness.md)).

After idle destroy, next message: if a session branch for this conversation still exists on the remote, **check it out** (then quietly update onto current default as above). Only uncommitted writes are lost. If there is no session branch, fork the current workspace base.

### Crash

If the provider can resume that thread snapshot, keep the dirty tree. If the container is gone: new fork from the workspace base — uncommitted writes **lost**. Postgres transcripts survive. Do not invent a default-branch commit to save them. A session branch already pushed still exists on GitHub.

### Job sandbox lifetime and size

One job sandbox per Workspace. Destroy after **60 minutes** with no running/queued job (code constant). Relink or desired-URL change → destroy now. GC unused chat **bases** when URL, desired SHA, or image id changes — do **not** destroy a live chat sandbox just because a job advanced the tip (Q7 updates it in place). Relink (URL/generation change) still destroys. Fargate v1: no sandbox to destroy; jobs still run.

**Same size as chat:** 1 vCPU, 1 GiB RAM, 128 PIDs, 4 GiB disk. Non-root, no privileged/device mounts, fail closed if an isolated provider cannot enforce that.

### Sol (2026-08-15) — do not close

Q1–Q6 recorded. Remaining: live chat vs desired-SHA rotation; what triggers a PR; restore of an existing session branch; PR/relink/delete end states.

### Round 2 (asked, 2026-08-15)

Sol refused close. Remaining: pin live chats across job pushes; explicit PR publish; checkout existing session branch after idle; bind PR to repo generation.

### Round 2 (human, 2026-08-15)

- **Q7:** Quietly update live chat onto fresh data when default advances. Do not leave the agent on a stale SHA if an update is possible.
- **Q8:** Explicit brokered request only. Dirtiness does not publish.
- **Q9:** After idle, check out the existing session branch if present; only uncommitted writes are lost.
- **Q10:** **No** one-PR / “new conversation after merge” limit. A conversation may create multiple PRs.
