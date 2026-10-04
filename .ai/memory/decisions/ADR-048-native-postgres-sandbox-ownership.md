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
- Hosted egress is an allowlist in Vercel's firewall (enforced outside the VM): our backend and GitHub, nothing else. OpenCode comes preinstalled from the agent snapshot (below), whose builder is the only sandbox allowed the npm registry. Self-host relies on the Docker network.
- The agent's OpenCode port is authenticated (server password, sent as headers by the provider's port channel), because Vercel ports are public URLs *(ticket 02)*.

### Identity and git

- The sandbox belongs to the conversation, keyed without the commit SHA (option D, *ticket 01*). Before a turn, if the default branch moved, the sandbox fetches and rebases its session branch in place with stock `exec`. The current SHA is recorded in our sandbox row, not in the key.
- Conversation work is committed and pushed to the session branch `ctxpipe/chat/<conversation>/<n>`. Git is the durable state; a sandbox is disposable and is recreated from the session branch when it is gone ([ADR-040](ADR-040-pierre-files-pane-chrome.md)).
- No credential is baked into the sandbox image, key or environment. The sandbox gets short-lived, HMAC-signed run capabilities bound to org, conversation, lock owner and revision (`workspace-chat-run-capability.ts`). It exchanges them through the backend for model access via the model proxy (`workspace-chat-model-proxy.ts`), so no model key enters the sandbox.
- Git reads use a GitHub installation token the backend mints on request (`workspace-chat-git-credentials.ts`): read-only, limited to the Workspace's repositories, valid up to an hour, and readable by the agent. Accepted (2026-10-02) because writes never use it: every push goes through the backend broker, only to the conversation's session branch.
- **Hosted (Vercel): the token stays outside the sandbox** (decided 2026-10-03). The firewall rule for `github.com` and `api.github.com` adds the `Authorization` header, so the token is never in the sandbox's environment or files. Each sandbox keeps one token for **10 minutes**. A turn does no token work while the token is younger than that. After that, the backend mints a fresh token (bypassing Octokit's cache) and replaces the rule, off the turn's critical path. It revokes the previous token after a ~30 s grace, and revokes the current one when the sandbox stops. Vercel returns injected header values as `<redacted>`, so the token is not readable through Vercel's API, and our only copy is an encrypted row per sandbox (`workspace_sandbox_git_tokens`, AES-GCM with the connection-secrets key) holding the token and its mint time. Measured: the rule update takes ~0.4 s and applies ~0.35 s later. Self-hosted Docker has no such firewall, so the same token reaches git through the session environment.

### Fast start: Workspace base

- Each Workspace has a **base**: a provider snapshot of a sandbox that cloned the Workspace repository (default branch, depth 1) and ran the provider's setup. It is a row of kind `base` in `workspace_sandbox_instances` (`workspace-sandbox-base.ts`): `image` is the agent image it was built on, `revision` the commit it holds, `latest_snapshot_id` the image or snapshot, `provider_sandbox_id` the builder, `created_at` the build time, `last_heartbeat_at` the last start from it. State `building` until published.
- **Start.** A new sandbox (a new conversation, or one whose sandbox is gone) starts from the Workspace's newest ready base for the current agent image and binding, chosen inside `create`, under the Workspace lock stock `ensure` already holds. An existing sandbox is resumed whatever it started from: the base is not in the sandbox key, because a sandbox outlives its base (measured on Docker: a stopped container restarts with its files after `rmi --force` of its image; the Vercel lane measures the same for a deleted source snapshot). Stock bootstrap skips the clone when `.git` exists, so setup only fetches the desired commit if the base lacks it and checks out the session branch. A base whose image or snapshot is gone is marked `destroy_failed` and the start goes on without it, once. With no usable base, or one behind the desired commit, the start goes ahead and requests a build (runs keyed by Workspace and 10-minute window, so concurrent starts share one); nothing waits for a build.
- **Build.** The OpenWorkflow job `workspace-sandbox-base` runs three durable steps ([ADR-047](ADR-047-native-durable-write-workflows.md)): `reserve` (decide, and record a `building` row under the Workspace lock and the org's slot lock), `build` (start the builder, clone, set up, capture; retried by OpenWorkflow up to three times; a retry deletes the previous attempt's builder or reuses a finished capture), `publish`. The `building` row is the build's lease (one hour): one build at a time per Workspace, and every write to it checks the lease under the Workspace lock and never recreates a deleted row. The builder id and the captured image or snapshot id are written as soon as they exist, so a crash at any point leaves them findable. A build whose lease lapsed or whose row was deleted (Workspace deleted or relinked) stops at its next check and deletes what it made. A builder runs a sandbox, so a `building` row takes one of the org's 50 slots; at the limit there is no build. A finished base runs nothing and takes none.
- **Stale.** A base is rebuilt once the default branch has moved and the base is a day old. A day of drift costs the pre-turn fetch of the changed files, which is small next to a rebuild for every push.
- **Docker** (no patch): the builder is a container of the chat image created by our code (so it carries labels) and wrapped in the stock `DockerHandle`; `docker commit` makes the base image, tagged `ctxpipe-workspace-base:<row>` and labelled `ai.ctxpipe.sandbox`, `ai.ctxpipe.store` (hash of the database host, port and name), `ai.ctxpipe.base`, `ai.ctxpipe.org`, `ai.ctxpipe.workspace`. Conversations use stock `dockerSandbox({ image: <base> })`; their containers inherit the image's labels. No secret reaches the image: create gets no environment, the clone token travels in the clone command's environment, and the chat image's credential helper never stores (proven by scanning a base built with a token).
- **Vercel** (no patch): conversations never reach npm. Per environment and OpenCode version there is an **agent snapshot**: a `node24` builder tagged `ctxpipe=workspace-agent` that can reach only `registry.npmjs.org`, installs OpenCode and is snapshotted with a 30-day expiry (built on first use, replaced in the background in its last week, spent builders deleted). Conversations without a base start from it, and Workspace base builders (tagged `ctxpipe=workspace-base`, GitHub token in the firewall rule) start from it, clone, set up and snapshot with no expiry. Snapshots carry no tags, so the stopped builder is kept as the snapshot's owner: deletion removes the snapshots listed under the builder first, then the builder, and the PR-close cleanup (`deletePreviewSandboxes.ts`) finds base and agent builders by environment tag.

### Lifecycle and limits

- An interactive sandbox stops after **5 minutes idle**; files are saved (Vercel snapshot on stop; Docker `stop`) and the next message resumes it. Idle is measured from the sandbox row's `last_heartbeat_at`, set when a turn, prepare or file read uses the sandbox and again when a turn ends (before the conversation lock is released). A sandbox is never stopped while a turn or file read holds the conversation lock `chat-thread:<conversation>`: the stop takes that lock without waiting and skips the sandbox if it is held. A stopped sandbox has row state `stopped`.
- A conversation's saved state is kept **30 days** after last use, then deleted with its row (Vercel delete also revokes the GitHub token); pushed work stays in git.
- Each organization runs at most **50 sandboxes** at once: live conversation and job rows of a running provider (Docker or Vercel), and Workspace base builds in progress; finished bases run nothing and do not count. Every start (a create, or the resume of a stopped sandbox) counts them under the org lock `org-sandbox-slots`, re-reading the row inside the lock. A create first reserves its row, so concurrent starts in other Workspaces see it, and releases it at once if the create or its setup fails. A resume whose row was deleted meanwhile starts a fresh sandbox instead of reviving the row. Over the limit the start fails with `SandboxCapacityError` (code `sandbox_capacity`): HTTP 429 on prepare, Files, pull-request and MCP, an "at capacity" `RUN_ERROR` in the chat stream, and an alert when a conversation opens. Unsandboxed runs have no sandbox and no limit.
- Runs nobody is watching stop their sandbox when the run ends (success, error or abort), so they never hold a slot: MCP `ctx_advisor` turns, and HTTP or WebSocket chats whose `source` is not `ui`. Each call site wraps the run (`stopConversationSandboxes`, `stoppingSandboxWhenDone`). The Slack mention agent does not use a workspace chat sandbox.
- Opening a conversation prepares its sandbox (warm for a fast first answer) and counts as use. Reading a file never creates a sandbox.
- Cancel kills the agent process where the provider supports it; otherwise (Vercel, until proven) it stops the sandbox.

### Cleanup

- There is no cron. The OpenWorkflow job `conversation-sandbox-sweep` (one org per run) stops idle sandboxes, deletes sandboxes past 30 days or whose conversation is gone, and retries failed deletes (`destroy_failed`).
- One chain per org: each run first sweeps, then, in a separate step (so a retried run does not compute a second next time), schedules the next run for when a running sandbox is next due. Runs are keyed by org and minute boundary. Due times come from state (last use plus 5 minutes), and retries (a turn holds the conversation, a stop or delete failed) go to the next 5-minute boundary, so runs that compute the same next time share one run.
- Every use schedules the sweep for its own idle time: a turn's end, a prepare or file read. The worker schedules a sweep at start for every org with a running sandbox, and every Workspace tip check schedules one, so a lost chain (a failed schedule, a crashed replica) restarts.
- Stopped sandboxes schedule nothing. Any later sweep for the org deletes those past 30 days as it passes. Vercel already expires saved state after 30 days. Docker leftovers in dormant orgs are removed by the host prune (below). So no run is scheduled weeks ahead, and every retry stays inside the PR worker's 10-minute idle window.
- Rows whose Workspace is deleted go with it; Workspace and conversation deletion destroy their sandboxes first (`workspace-sandbox-cleanup.ts`). Relink and Workspace deletion destroy bases too, after the conversation sandboxes (a Docker daemon keeps an image a container uses).
- **Bases** are deleted by the org's sweep only, under the Workspace lock new sandboxes take to choose their base: every base but the current one (a newer base, another agent image or provider, a relinked Workspace) at once; the current one once no new sandbox started from it for 30 days; builds past their lease; failed deletes. Docker refuses to delete an image a running container uses: the row stays for a later sweep. Skipped when the deployment's agent image cannot be read, so a daemon blip never deletes the base new conversations should use. The worker-start backstop sweeps every org with a running sandbox, a base, or a sandbox past 30 days (`orgsNeedingSweep`).
- **Docker host prune** (`docker-sandbox-host-prune.ts`): a step of every sweep run on Docker deployments, so it follows the sweep cadence (the host's disk only grows while sandboxes run) with no scheduler of its own. It sweeps every org with a conversation sandbox past 30 days or a failed delete (stock containers carry no labels, so this works from `provider_sandbox_id`), then removes objects labelled with this deployment's database that no row records: base images whose base row is gone (checked at removal, so a build that has committed but not yet published is safe), and containers over an hour old (lost builders, containers started from a base). Images of other deployments sharing the daemon, unlabelled objects, and images a running container uses are never touched. Unreachable: a container started from the plain chat image whose row was removed without destroying it; our code never does that (a failed delete keeps the row as `destroy_failed`).

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
