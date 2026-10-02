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

### Isolation

Only stock TanStack sandbox policy: `commands`, `capabilities.fileWrite`, `capabilities.network`, `default`. No egress proxy, per-run grants, resource quotas, Btrfs runner or custom isolation patches *(ticket 01)*.

### Identity and git

- The sandbox belongs to the conversation, keyed without the commit SHA (option D, *ticket 01*). Before a turn, if the default branch moved, the sandbox fetches and rebases its session branch in place with stock `exec`. The current SHA is recorded in our sandbox row, not in the key.
- Conversation work is committed and pushed to the session branch `ctxpipe/chat/<conversation>/<n>`. Git is the durable state; a sandbox is disposable and is recreated from the session branch when it is gone ([ADR-040](ADR-040-pierre-files-pane-chrome.md)).
- Credentials never live in the sandbox image, key or environment. The sandbox gets short-lived, HMAC-signed run capabilities bound to org, conversation, lock owner and revision (`workspace-chat-run-capability.ts`). It exchanges them through the backend for a git credential (`workspace-chat-git-credentials.ts`) or for model access via the model proxy (`workspace-chat-model-proxy.ts`).

### Cleanup

- A periodic cleanup (`workspace-sandbox-cleanup.ts`) destroys idle sandboxes and rows whose Workspace or conversation is gone. Failed destroys keep their row and retry.
- Self-hosted Docker hosts must also remove stopped containers and unused images, so the host never runs out of disk *(ticket 03)*.

## Consequences

- Replicas can restart or hand over mid-conversation; the lock and store carry ownership, git carries the work.
- Losing a sandbox costs one cold start, never user work that was pushed.
- Isolation is whatever the provider plus stock policy gives. Vercel provides microVM isolation for hosted. Self-hosters rely on Docker.
- Until ticket 01 lands, the branch still carries the patched runtime-workspace, transition and isolation code this ADR retires.

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
