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
- **Hosted (Vercel): the token stays outside the sandbox** (decided 2026-10-03). The firewall rule for `github.com` and `api.github.com` adds the `Authorization` header, so the token is never in the sandbox's environment or files. Each sandbox keeps one token for **10 minutes**. A turn does no token work while the token is younger than that. After that, the backend mints a fresh token (bypassing Octokit's cache) and replaces the rule, off the turn's critical path. It revokes the previous token after a ~30 s grace, and revokes the current one when the sandbox stops. Vercel returns injected header values as `<redacted>`, so the token is not readable through Vercel's API, and our only copy is an encrypted row per sandbox (`workspace_sandbox_git_tokens`, AES-GCM with the connection-secrets key) holding the token and its mint time. Measured: the rule update takes ~0.4 s and applies ~0.35 s later. Self-hosted Docker has no such firewall, so the same token reaches git through the session environment.

### Fast start: Workspace base

- Each Workspace has a **base**: a provider snapshot of a sandbox that cloned the Workspace repository (default branch, depth 1) and ran the provider's setup. It is a row of kind `base` in `workspace_sandbox_instances` (`workspace-sandbox-base.ts`): `image` is the agent image it was built on, `revision` the commit it holds, `latest_snapshot_id` the image or snapshot, `provider_sandbox_id` the builder (Vercel) or the image (Docker), `created_at` the build time, `last_heartbeat_at` the last time a conversation was started from it. State `building` until the build publishes it.
- **Build.** The OpenWorkflow job `workspace-sandbox-base` builds it on the worker. One build at a time per Workspace: a build holds the lock `workspace-base:<workspace>`, and a second one returns at once. The Workspace lock `workspace-sandboxes:<workspace>` is held only to record the builder and to publish the result, so Workspace deletion and relink still fence a build (the publish step deletes what it built if its row is gone), and conversation starts never wait for a build.
- **Start.** A conversation that already has a sandbox for the current agent image and Workspace binding keeps it, and the base it started from. A new one starts from the Workspace's newest base. The base is part of the conversation's image identity (`<agent image>+base:<snapshot>`), which is in the sandbox key and the row the same way the image id was, so a new base gives new conversations new sandboxes while existing ones keep theirs. With no base, or one behind the desired commit, the start goes ahead as before and requests a build (runs keyed by Workspace and 10-minute window, so concurrent starts share one); the first turn never waits. Stock bootstrap skips the clone when `.git` exists, so the pre-turn setup only fetches the desired commit if the base lacks it and checks out the session branch.
- **Stale.** A base is rebuilt when the default branch has moved and the base is a day old, or when the branch is more than **50 commits** ahead of it (GitHub compare API; other hosts use age only). Workspace repositories take many small automated commits (hydrate, connector mirrors), so fifty is about a busy day; below that the pre-turn fetch stays small, above it a rebuild (seconds, off the critical path) is cheaper than every new conversation fetching the backlog.
- **Docker** (no patch): the builder is a container of the chat image; `docker commit` makes the base image, tagged `ctxpipe-workspace-base:<row>` and labelled `ai.ctxpipe.sandbox=workspace-base`, `ai.ctxpipe.store=<hash of the database host, port and name>`, `ai.ctxpipe.base=<row>`, `ai.ctxpipe.org`, `ai.ctxpipe.workspace`. Conversations use stock `dockerSandbox({ image: <base> })`. Secrets never reach the image: create gets no environment and the clone token travels in the clone command's environment.
- **Vercel** (no patch): the builder is a `node24` sandbox tagged `ctxpipe=workspace-base, environment=<Railway environment>`, with the GitHub token in its firewall rule and the npm registry allowed; it clones and installs OpenCode, then `sandbox.snapshot({ expiration: 0 })` (no expiry) stops it and its token is revoked. The stopped builder is kept as the snapshot's owner, so the PR-close cleanup (`deletePreviewSandboxes.ts`) finds it by tag and deletes it with the snapshot. Conversations start with `source: { type: "snapshot" }` and never install OpenCode; only builders and conversation sandboxes started before their Workspace had a base may reach the npm registry.
- Bases run nothing, so they never count toward the 50-per-org limit.

### Lifecycle and limits

- An interactive sandbox stops after **5 minutes idle**; files are saved (Vercel snapshot on stop; Docker `stop`) and the next message resumes it. Idle is measured from the sandbox row's `last_heartbeat_at`, set when a turn, prepare or file read uses the sandbox and again when a turn ends (before the conversation lock is released). A sandbox is never stopped while a turn or file read holds the conversation lock `chat-thread:<conversation>`: the stop takes that lock without waiting and skips the sandbox if it is held. A stopped sandbox has row state `stopped`.
- A conversation's saved state is kept **30 days** after last use, then deleted with its row (Vercel delete also revokes the GitHub token); pushed work stays in git.
- Each organization runs at most **50 sandboxes** at once: live conversation and job rows of a running provider (Docker or Vercel); Workspace bases run nothing and do not count. Every start (a create, or the resume of a stopped sandbox) counts them under the org lock `org-sandbox-slots`, re-reading the row inside the lock. A create first reserves its row, so concurrent starts in other Workspaces see it, and releases it at once if the create or its setup fails. A resume whose row was deleted meanwhile starts a fresh sandbox instead of reviving the row. Over the limit the start fails with `SandboxCapacityError` (code `sandbox_capacity`): HTTP 429 on prepare, Files, pull-request and MCP, an "at capacity" `RUN_ERROR` in the chat stream, and an alert when a conversation opens. Unsandboxed runs have no sandbox and no limit.
- Runs nobody is watching stop their sandbox when the run ends (success, error or abort), so they never hold a slot: MCP `ctx_advisor` turns, and HTTP or WebSocket chats whose `source` is not `ui`. Each call site wraps the run (`stopConversationSandboxes`, `stoppingSandboxWhenDone`). The Slack mention agent does not use a workspace chat sandbox.
- Opening a conversation prepares its sandbox (warm for a fast first answer) and counts as use. Reading a file never creates a sandbox.
- Cancel kills the agent process where the provider supports it; otherwise (Vercel, until proven) it stops the sandbox.

### Cleanup

- There is no cron. The OpenWorkflow job `conversation-sandbox-sweep` (one org per run) stops idle sandboxes, deletes sandboxes past 30 days or whose conversation is gone, and retries failed deletes (`destroy_failed`).
- One chain per org: each run first sweeps, then, in a separate step (so a retried run does not compute a second next time), schedules the next run for when a running sandbox is next due. Runs are keyed by org and minute boundary. Due times come from state (last use plus 5 minutes), and retries (a turn holds the conversation, a stop or delete failed) go to the next 5-minute boundary, so runs that compute the same next time share one run.
- Every use schedules the sweep for its own idle time: a turn's end, a prepare or file read. The worker schedules a sweep at start for every org with a running sandbox, and every Workspace tip check schedules one, so a lost chain (a failed schedule, a crashed replica) restarts.
- Stopped sandboxes schedule nothing. Any later sweep for the org deletes those past 30 days as it passes. Vercel already expires saved state after 30 days. Docker leftovers in dormant orgs are removed by the host prune (below). So no run is scheduled weeks ahead, and every retry stays inside the PR worker's 10-minute idle window.
- Rows whose Workspace is deleted go with it; Workspace and conversation deletion destroy their sandboxes first (`workspace-sandbox-cleanup.ts`). Relink and Workspace deletion destroy bases too, after the conversation sandboxes (a Docker daemon keeps an image a container uses).
- **Bases** are deleted by every sweep of their org, every tip check, and the base job after a build: a superseded or obsolete base (newer base, other agent image or provider, relinked Workspace) once no conversation sandbox row started from it; the current base once no conversation started from it for 7 days; a lost build at once. A base chosen for a new conversation is kept at least 10 minutes, so its create never finds it gone. Skipped while a build runs, and where the deployment has no sandbox provider (a daemon briefly unreachable never costs the current base). The worker-start backstop also sweeps orgs that have bases.
- **Docker host prune** (`docker-sandbox-host-prune.ts`, OpenWorkflow job `docker-sandbox-host-prune`): at most once an hour, requested at worker start and by every conversation sweep, Docker deployments only. It runs the sweep of every org holding a Docker conversation sandbox past 30 days or a failed delete (stock containers carry no labels, so this works from `provider_sandbox_id`), then removes base images labelled with this deployment's database whose base row is gone (checked at removal, so a build that has committed but not yet published is safe) and that no conversation row started from. The daemon refuses images a container still uses; images of other deployments sharing the daemon, and unlabelled images, are never touched. With no sandbox in use anywhere, the host's disk does not grow, so no run is needed.

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
