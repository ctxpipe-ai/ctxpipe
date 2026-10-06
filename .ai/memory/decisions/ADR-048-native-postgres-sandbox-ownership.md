# ADR-048: Conversation sandboxes: stock providers, Postgres ownership, git as durable state

**Status:** Accepted (revised 2026-10-02) | **Date:** 2026-09-09 | **Tags:** tanstack, postgres, sandbox, chat

## Context

Every Workspace conversation runs OpenCode in its own sandbox with a checkout of the Workspace repository ([ADR-044](ADR-044-workspace-chat-stock-tanstack.md)). Backend replicas restart and scale, so sandbox ownership must live outside the process. PR 280's recovery reached that through ~9.9k lines of patches to TanStack's sandbox, Docker and OpenCode packages (custom isolation, egress proxy, runtime workspace swaps, live revision moves). This revision records what we keep and what we decided instead. Items marked *(ticket NN)* are decided but not yet shipped; see `.ai/scratchpad/pr-280-release/`.

## Decision

### Ownership

- TanStack `defineSandbox` with our Postgres `SandboxInstanceStore` (`sandbox-instance-store.ts`) and `LockStore` (`sandbox-lock-store.ts`). Keys are exact: a missing key returns null; upsert replaces that key's record.
- Locks are tenant-scoped rows with expiring owner tokens. Acquire, renew and release are each a short RLS transaction; no SQL spans provider I/O ([ADR-041](ADR-041-short-org-sql-unique-sandbox-rows.md)). Losing the lease aborts the run.
- Creating a sandbox and deleting a Workspace or conversation take the same workspace-scoped lock first, so deletion cannot race a first ensure.
- No process-owned registries or handle caches.

### Providers

| Deployment | Provider |
| --- | --- |
| Hosted | `@tanstack/ai-sandbox-vercel` *(ticket 02)* |
| Self-host (Compose) | stock `dockerSandbox` against a Docker-in-Docker service. See [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md). |
| Self-host (AWS CDK) | stock `dockerSandbox` against an always-created EC2 Graviton Docker host. See [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md). |
| Local dev | stock `dockerSandbox` against the developer's Docker |
| Unsandboxed | explicit `SANDBOX_PROVIDER=unsandboxed` only; never chosen automatically, never recommended |

Hosted needs CPU billed only while busy (an agent mostly waits on the model), a TanStack provider, fast start and durable files. Vercel is the chosen vendor: microVM isolation, an existing vendor, and 10,000 concurrent sandboxes. Its provider gaps (start from snapshot, authenticated agent port, process kill) are temporary patches, upstreamed after launch.

### Isolation and egress

- In the sandbox, only stock TanStack policy: `commands`, `capabilities.fileWrite`, `capabilities.network`, `default`. No custom egress proxy, per-run grants, resource quotas, Btrfs runner or isolation patches *(ticket 01)*.
- Hosted egress is an allowlist in Vercel's firewall (enforced outside the VM): our backend, GitHub, and what OpenCode needs *(ticket 02)*. Self-host relies on the Docker network.
- The agent's OpenCode port is authenticated (server password, sent as headers by the provider's port channel), because Vercel ports are public URLs *(ticket 02)*.

### Identity and git

- The sandbox belongs to the conversation, keyed without the commit SHA (option D, *ticket 01*). Before a turn, if the default branch moved, the sandbox fetches and rebases its session branch in place with stock `exec`. The current SHA is recorded in our sandbox row, not in the key.
- Conversation work is committed by the agent and pushed to the session branch `ctxpipe/chat/<conversation>/<n>` through the broker (the agent's tool or Commit+Push). The broker replaces the remote tip only when it is the tip ctx| pushed last; committed work is pushed before a sandbox is deleted. Git is the durable state; a sandbox is disposable and is recreated from the session branch when it is gone ([ADR-040](ADR-040-pierre-files-pane-chrome.md)).
- No credential is baked into the sandbox image, key or environment. The sandbox gets short-lived, HMAC-signed run capabilities bound to org, conversation, lock owner and revision (`workspace-chat-run-capability.ts`). It exchanges them through the backend for model access via the model proxy (`workspace-chat-model-proxy.ts`), so no model key enters the sandbox.
- Git reads use a GitHub installation token the backend mints on request (`workspace-chat-git-credentials.ts`): read-only, limited to the Workspace's repositories, valid up to an hour, and readable by the agent. Accepted (2026-10-02) because writes never use it: every push goes through the backend broker, only to the conversation's session branch.
- **Hosted (Vercel): the token stays outside the sandbox** (decided 2026-10-03). The firewall rule for `github.com` and `api.github.com` adds the `Authorization` header, so the token is never in the sandbox's environment or files. Each sandbox keeps one token for **10 minutes**. A turn does no token work while the token is younger than that. After that, the backend mints a fresh token (bypassing Octokit's cache) and replaces the rule, off the turn's critical path. It revokes the previous token after a ~30 s grace, and revokes the current one when the sandbox stops. Vercel returns injected header values as `<redacted>`, so the token is not readable through Vercel's API, and our only copy is an encrypted row per sandbox (`workspace_sandbox_git_tokens`, AES-GCM with the connection-secrets key) holding the token and its mint time. Measured: the rule update takes ~0.4 s and applies ~0.35 s later. Self-hosted Docker has no such firewall, so the same token reaches git through the session environment.

### Fast start: Workspace base

- Each Workspace has a **base**: a provider snapshot of a sandbox that cloned the Workspace repository and ran setup. Our code builds it (one build at a time, under the Workspace lock), records it in the sandbox table, rebuilds it when it falls well behind the default branch, and deletes old bases once no sandbox uses them.
- A new conversation starts from the base; the pre-turn update only fetches the latest commit and checks out the session branch.
- Docker: the base is a committed image passed as `dockerSandbox({ image })`, stock and no patch *(ticket 03)*. Vercel: a snapshot passed as the sandbox source, a temporary provider patch *(ticket 02)*.

### Lifecycle and limits

- An interactive sandbox stops after **5 minutes idle**; files are saved (Vercel snapshot on stop; Docker `stop`) and the next message resumes it. Idle is measured from the sandbox row's `last_heartbeat_at`, set when a turn, prepare or file read uses the sandbox and again when a turn ends (before the conversation lock is released). A sandbox is never stopped while a turn or file read holds the conversation lock `chat-thread:<conversation>`: the stop takes that lock without waiting and skips the sandbox if it is held. A stopped sandbox has row state `stopped`.
- A conversation's saved state is kept **30 days** after last use, then deleted with its row (Vercel delete also revokes the GitHub token); pushed work stays in git.
- Each organization runs at most **50 sandboxes** at once: live rows of a running provider (Docker or Vercel), of any kind. Every start (a create, or the resume of a stopped sandbox) counts them under the org lock `org-sandbox-slots`, re-reading the row inside the lock. A create first reserves its row, so concurrent starts in other Workspaces see it, and releases it at once if the create or its setup fails. A resume whose row was deleted meanwhile starts a fresh sandbox instead of reviving the row. Over the limit the start fails with `SandboxCapacityError` (code `sandbox_capacity`): HTTP 429 on prepare, Files, pull-request and MCP, an "at capacity" `RUN_ERROR` in the chat stream, and an alert when a conversation opens. Unsandboxed runs have no sandbox and no limit.
- Runs nobody is watching stop their sandbox when the run ends (success, error or abort), so they never hold a slot: MCP `ctx_advisor` turns, and HTTP or WebSocket chats whose `source` is not `ui`. Each call site wraps the run (`stopConversationSandboxes`, `stoppingSandboxWhenDone`). The Slack mention agent does not use a workspace chat sandbox.
- Opening a conversation prepares its sandbox (warm for a fast first answer) and counts as use. Reading a file never creates a sandbox.
- Cancel kills the agent process where the provider supports it; otherwise (Vercel, until proven) it stops the sandbox.

### Cleanup

- There is no cron. The OpenWorkflow job `conversation-sandbox-sweep` (one org per run) stops idle sandboxes, deletes sandboxes 29 days after their last use (a day before Vercel expires saved state) or when their conversation is gone, and retries failed deletes (`destroy_failed`). Before a deletion, it pushes committed work. It keeps a sandbox while a local branch has commits that no remote has, until the saved state expires.
- One chain per org: each run first sweeps, then, in a separate step (so a retried run does not compute a second next time), schedules the next run for when a running sandbox is next due. Runs are keyed by org and minute boundary. Due times come from state (last use plus 5 minutes), and retries (a turn holds the conversation, a stop or delete failed) go to the next 5-minute boundary, so runs that compute the same next time share one run.
- Every use schedules the sweep for its own idle time: a turn's end, a prepare or file read. The worker schedules a sweep at start for every org with a running sandbox, and every Workspace tip check schedules one, so a lost chain (a failed schedule, a crashed replica) restarts.
- A stopped sandbox schedules a due time for its deletion, 29 days after its last use. Vercel expires saved state after 30 days, so the push before the deletion can still resume the sandbox. Docker leftovers in dormant orgs are removed by the host prune *(ticket 03)*. Retries stay inside the PR worker's 10-minute idle window.
- Rows whose Workspace is deleted go with it; Workspace and conversation deletion destroy their sandboxes first (`workspace-sandbox-cleanup.ts`).
- On self-hosted Docker, a host prune keeps the disk from filling. Stock containers have no labels, so it sweeps every org with a sandbox row and works from the container id in each row. Then it removes base images, builders, and containers with our labels that no row records ([ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md)) *(ticket 03)*. Hosted deletes Vercel snapshots past retention and unused bases.

## Consequences

- Replicas can restart or hand over mid-conversation; the lock and store carry ownership, git carries the work.
- Losing a sandbox costs one cold start, never user work that was pushed.
- Isolation is whatever the provider plus stock policy gives. Vercel provides microVM isolation for hosted. Self-hosters rely on Docker.
- Semantic merge needs no sandbox: it is one schema-checked model call whose output native Git stages.
- Stock Docker passes create options, including the environment, in the request URL, so our provider wrapper (`withSessionOnlyEnv`) drops them from create and sets secrets on the session instead.

## Alternatives considered

- **Railway Sandboxes for hosted.** Rejected: capped at 100 concurrent sandboxes per environment, no TanStack provider.
- **Cloudflare Sandboxes.** Rejected: TanStack's provider only runs inside a Cloudflare Worker, files are lost when the container sleeps, no snapshots or process kill.
- **Upstash Box.** Rejected: container isolation (shared kernel across tenants), SOC 2 in progress, no custom images, despite the best price and TanStack integration.
- **E2B, Daytona.** Rejected: CPU and memory billed while reserved, not only while busy. Daytona is also closed source since June 2026, and its lower tiers cannot reach our backend.
- **Fly.io Sprites.** Fallback: microVM, durable files, idle is free, but no shared snapshot start and concurrency bought by plan.
- **ECS RunTask per conversation for AWS CDK.** Rejected: start time and per-task cost are worse than one shared Docker host.
- **sbx.** Parked; see [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md).
- **Moving a sandbox between SHA-keyed records (the patched transition hooks).** Rejected in favour of option D, which needs no patch.
- **Pinning a conversation to its start commit.** Rejected: the agent would read stale knowledge.
