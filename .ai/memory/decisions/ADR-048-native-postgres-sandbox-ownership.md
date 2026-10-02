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
| Self-host (Compose) | stock `dockerSandbox` against a Docker-in-Docker service *(ticket 03)* |
| Self-host (AWS CDK) | stock `dockerSandbox` against an always-created EC2 Graviton Docker host *(ticket 03)* |
| Local dev | stock `dockerSandbox` against the developer's Docker |
| Unsandboxed | explicit `SANDBOX_PROVIDER=unsandboxed` only; never chosen automatically, never recommended |

Hosted needs CPU billed only while busy (an agent mostly waits on the model), a TanStack provider, fast start and durable files. Vercel is the chosen vendor: microVM isolation, an existing vendor, and 10,000 concurrent sandboxes. Its provider gaps (start from snapshot, authenticated agent port, process kill) are temporary patches, upstreamed after launch.

### Isolation and egress

- In the sandbox, only stock TanStack policy: `commands`, `capabilities.fileWrite`, `capabilities.network`, `default`. No custom egress proxy, per-run grants, resource quotas, Btrfs runner or isolation patches *(ticket 01)*.
- Hosted egress is an allowlist in Vercel's firewall (enforced outside the VM): our backend, GitHub, and what OpenCode needs *(ticket 02)*. Self-host relies on the Docker network.
- The agent's OpenCode port is authenticated (server password, sent as headers by the provider's port channel), because Vercel ports are public URLs *(ticket 02)*.

### Identity and git

- The sandbox belongs to the conversation, keyed without the commit SHA (option D, *ticket 01*). Before a turn, if the default branch moved, the sandbox fetches and rebases its session branch in place with stock `exec`. The current SHA is recorded in our sandbox row, not in the key.
- Conversation work is committed and pushed to the session branch `ctxpipe/chat/<conversation>/<n>`. Git is the durable state; a sandbox is disposable and is recreated from the session branch when it is gone ([ADR-040](ADR-040-pierre-files-pane-chrome.md)).
- No credential is baked into the sandbox image, key or environment. The sandbox gets short-lived, HMAC-signed run capabilities bound to org, conversation, lock owner and revision (`workspace-chat-run-capability.ts`). It exchanges them through the backend for model access via the model proxy (`workspace-chat-model-proxy.ts`), so no model key enters the sandbox.
- Git reads use a GitHub installation token the backend mints on request (`workspace-chat-git-credentials.ts`): read-only, limited to the Workspace's repositories, valid up to an hour, and readable by the agent. Accepted (2026-10-02) because writes never use it: every push goes through the backend broker, only to the conversation's session branch.
- **Hosted (Vercel): the token stays outside the sandbox** (decided 2026-10-03). The firewall rule for `github.com` and `api.github.com` adds the `Authorization` header, so the token is never in the sandbox's environment or files. Each sandbox keeps one token for **10 minutes**. A turn does no token work while the token is younger than that. After that, the backend mints a fresh token (bypassing Octokit's cache) and replaces the rule, off the turn's critical path. It revokes the previous token after a ~30 s grace, and revokes the current one when the sandbox stops. Measured: the rule update takes ~0.4 s and applies ~0.35 s later. Self-hosted Docker has no such firewall, so the same token reaches git through the session environment.

### Fast start: Workspace base

- Each Workspace has a **base**: a provider snapshot of a sandbox that cloned the Workspace repository and ran setup. Our code builds it (one build at a time, under the Workspace lock), records it in the sandbox table, rebuilds it when it falls well behind the default branch, and deletes old bases once no sandbox uses them.
- A new conversation starts from the base; the pre-turn update only fetches the latest commit and checks out the session branch.
- Docker: the base is a committed image passed as `dockerSandbox({ image })`, stock and no patch *(ticket 03)*. Vercel: a snapshot passed as the sandbox source, a temporary provider patch *(ticket 02)*.

### Lifecycle and limits

- An interactive sandbox stops after **5 minutes idle**; files are saved (Vercel snapshot on stop; Docker `stop`) and the next message resumes it.
- A conversation's saved state is kept **30 days** after last use, then deleted; pushed work stays in git.
- Each organization runs at most **50 sandboxes** at once; the limit is checked before create, with a clear "at capacity" error.
- Runs nobody is watching (MCP `ctx_advisor` turns, Slack agent turns) stop their sandbox as soon as the run ends, so they never hold a slot.
- Cancel kills the agent process where the provider supports it; otherwise (Vercel, until proven) it stops the sandbox.

### Cleanup

- A periodic cleanup (`workspace-sandbox-cleanup.ts`) stops idle sandboxes, deletes state past 30 days, and removes rows whose Workspace or conversation is gone. Failed destroys keep their row and retry.
- Self-hosted Docker hosts also remove stopped containers and unused images (labelled by owner), so the host never runs out of disk *(ticket 03)*. Hosted deletes Vercel snapshots past retention and unused bases.

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
- **sbx.** Parked: it adds a second runtime without a need stock policy leaves unmet.
- **Moving a sandbox between SHA-keyed records (the patched transition hooks).** Rejected in favour of option D, which needs no patch.
- **Pinning a conversation to its start commit.** Rejected: the agent would read stale knowledge.
