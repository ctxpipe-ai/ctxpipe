# Docker sandboxing for self-hosters (Compose + AWS CDK)

Status: ready
Priority: P0
Owner: unassigned
Blocked by: 01
Created: 2026-10-01
Updated: 2026-10-02

## Context

User decisions (2026-10-01):

- Self-host sandboxes run on stock TanStack `dockerSandbox` (sbx/microVMs considered and parked: needs KVM, no snapshots/forks, local-only CLI, unclear headless login/licensing).
- Isolation is what stock TanStack sandbox policy supports; no quotas, egress proxy, or Btrfs runner.
- AWS CDK gets an **EC2 Docker sandbox host** (not Fargate `RunTask`). Containers and snapshot images must be cleaned up so the host never runs out of disk.
- Unsandboxed is a last-resort fallback where nothing else works, never the default or recommended.
- `@ctxpipe/aws-cdk` ships this as a **minor, non-breaking** release: bump the construct, `cdk deploy`, no new required props.

Today:

- **Compose** runs a custom `ctxpipe-sandbox-runner` (DinD with a Btrfs storage file, mutual TLS, quota probe) plus `chat-sandbox-image` and `sandbox-model-relay` services (`docker-compose.yml`, `scripts/sandbox-runner/`). Built for the quota/egress design being dropped.
- **CDK** runs backend/worker/UI/codesearch on Fargate with no Docker daemon, so chat would run unsandboxed.
- Stock `dockerSandbox` config: `image`, `workdir`, `dockerodeOptions` (socket or TCP+TLS), `keepAliveCommand`, `publishPorts`, `hostGateway`, `removeOnDestroy` (default true), `logger`. No CPU/memory/PID options; snapshots are `docker commit` images, which accumulate unless deleted.

## Goal

Self-hosters get sandboxed workspace chat by default on both Compose and CDK, using stock `dockerSandbox`, with bounded disk use and no extra required configuration.

## Acceptance criteria

- [ ] Compose: `pnpm start` (deploy profile) gives sandboxed chat with no extra settings; backend never mounts the host Docker socket.
- [ ] Custom runner, Btrfs storage, quota probe, egress proxy, and model relay removed from Compose and `scripts/` (deletion ledger).
- [ ] CDK: a new internal construct provisions one EC2 Docker sandbox host (private subnet, Docker API over TLS, certs in Secrets Manager); backend + worker get `SANDBOX_PROVIDER=docker` and the connection settings automatically.
- [ ] Existing CDK users upgrade with `pnpm update @ctxpipe/aws-cdk` + `cdk deploy`; no new required props; optional props for instance type and disk size; minor changeset.
- [ ] Host protection without patches: all sandbox containers run under one capped cgroup (`cgroup-parent` in `daemon.json`), and the host has a disk-usage alarm.
- [ ] Cleanup: containers removed on destroy and idle expiry; snapshot images deleted when their last owner row goes; a periodic labeled prune catches orphans; disk stays flat across repeated browser-suite runs.
- [ ] Sandboxes reach only what they need (backend model proxy + tool bridge, Git host); documented, not enforced beyond stock policy.
- [ ] `examples/aws-cdk-self-host` deploys and passes preview-env `chat` against it (manual e2e, recorded).
- [ ] Fast start (option B, no patch): each Workspace has a base image (committed after clone + setup). New conversations start from it with `dockerSandbox({ image })`. Bases are rebuilt when stale and deleted when unused. Proven by a native contract test: no clone in the first turn, one build under concurrent starts.
- [ ] Lifecycle matches hosted:
  - `docker stop` after 5 minutes idle, resumed with `docker start`;
  - stopped containers removed 30 days after last use;
  - at most 50 running sandboxes per organization;
  - non-interactive runs stop their container as soon as they finish.
- [ ] Self-hosting docs updated: architecture, Compose and CDK sandbox sections, operations checks (disk, health), unsandboxed marked last resort.

## Plan

1. **Compose simplification.** Replace the custom runner with stock `docker:dind` (TLS on via `DOCKER_TLS_CERTDIR`, named volume for `/var/lib/docker`, `daemon.json` with `cgroup-parent` + log rotation). Backend/worker use `DOCKER_HOST=tcp://dind:2376` + client certs. Build the chat image inside dind at startup (keep the existing `chat-sandbox-image` step if still needed). Remove `sandbox-model-relay`; sandboxes reach the backend through the dind network / `hostGateway`. Prove: two chats, restart dind, chats resume or re-create cleanly.
2. **Workspace base images (option B).** Base builder: create a sandbox from the stock chat image, clone the Workspace repository, run setup, `docker commit` with owner labels; record the image in the sandbox table. One build at a time per Workspace under the existing Postgres lock. Rebuild when the base is more than N commits or a day behind; delete bases no container uses. New conversations use `dockerSandbox({ image: base })`; the pre-turn update fetches the tip and checks out the session branch.
3. **Cleanup owner.** Label every sandbox container and snapshot image with org/workspace/conversation ids. Extend `workspace-sandbox-cleanup.ts`: destroy idle sandboxes past keep-alive, delete snapshot images whose owner rows are gone, then `docker container prune` / `image prune` filtered by our labels. Run it from the existing periodic workflow. Prove with a native contract test that creates, snapshots, forks, expires, and asserts nothing labeled remains.
4. **CDK sandbox host construct.** Add `SandboxHostConstruct` to `packages/aws-cdk/src/internal/`: single-instance ASG (self-healing) on the Graviton instance for the `size` profile (table above, overridable), gp3 root + data volume for `/var/lib/docker`, user data installing Docker with TLS and the same `daemon.json`, certs generated once into Secrets Manager, security group allowing 2376 only from backend/worker and sandbox → backend ports. Inject `SANDBOX_PROVIDER=docker`, `DOCKER_HOST`, and certs into backend/worker task definitions. CloudWatch disk + memory alarms. Default on; no new required props.
5. **Backend wiring.** Provider selection reads the configured daemon; remove unsandboxed auto-fallback when a daemon is configured but unreachable (fail closed). Keep `unsandboxed` reachable only by explicit `SANDBOX_PROVIDER=unsandboxed`, with a startup warning.
6. **Upgrade path test.** Deploy the previous published construct in a sandbox AWS account, then upgrade to this one: no data loss, no manual steps. Record in the ticket.
7. **Docs + changeset.** Self-hosting docs for Compose and CDK sandboxing; minor changeset for `@ctxpipe/aws-cdk`; ADR for "self-host sandbox = stock dockerSandbox on DinD/EC2" (feeds ticket 08).

## Instance sizing (user, 2026-10-01: ARM, cheap — the host does little work)

The host mostly holds idle sandboxes; CPU bursts are short (clone, grep, tests) and model calls run elsewhere. Burstable Graviton (`t4g`, unlimited credits) is the cheapest fit; memory is the real limit (~0.3–0.5 GiB per active sandbox). Prices are us-east-1 on-demand, approximate, including the gp3 Docker volume.

| `size` | Instance | vCPU / RAM | Docker volume | ~Cost/month | Resident sandboxes (est.) |
| --- | --- | --- | --- | --- | --- |
| small | `t4g.medium` | 2 / 4 GiB | 30 GB | ~$27 | ~6 |
| medium | `t4g.large` | 2 / 8 GiB | 50 GB | ~$53 | ~14 |
| large | `t4g.xlarge` | 4 / 16 GiB | 100 GB | ~$106 | ~30 |

Keep memory low by stopping (`docker stop`) sandboxes idle for 5 minutes and resuming with `docker start` on the next turn. Stopped containers keep their files for 30 days, so size the Docker volume for stopped containers too. Overridable via optional props. ARM means the chat image is built `linux/arm64`. Validate with the browser suite (ticket 06) before release.

## Decisions

- No opt-out: the CDK construct always creates the sandbox host; sandboxing is a safety feature (user, 2026-10-01).
- Compose default is DinD (privileged sidecar); the backend never mounts the host Docker socket (user, 2026-10-01).

## Open questions

None.

## Delegation brief

Read first: this ticket, ticket 01's ledger, `docker-compose.yml`, `scripts/sandbox-runner/`, `scripts/chat-sandbox/`, `sandbox-provider.ts`, `workspace-sandbox-cleanup.ts`, `workspace-chat-docker-policy.ts`, `packages/aws-cdk/src/internal/*`, `packages/aws-cdk/README.md`, `.cursor/skills/aws-cdk/`, ADR-015 (Compose profiles).

Do not add TanStack patches or an application-level sandbox registry. Keep construct changes backwards compatible. Report: deletion ledger, cleanup proof output, CDK synth diff summary, upgrade-path result.

## Comments

- 2026-10-04 (claude): **Workspace base, third review round:**
  - Builds are retry-safe:
    - the reserve id comes from the workflow run;
    - publish is folded into the build as one conditional UPDATE, and a published or recorded capture is reused on retry;
    - a failed attempt's builder is removed;
    - the Docker base row no longer stores the image id as `provider_sandbox_id`.
  - Only builds with a held lease count toward the 50.
  - New builds are requested only when the base is stale.
  - The host prune runs once per 5-minute sweep window (one OpenWorkflow run, not one per org) and reads each org's rows once.
  - `orgsNeedingSweep` includes orgs whose bases cleanup may delete.
  - New native proofs: a retried reserve, a retried build after a failed attempt and after a crash before publish, and cap accounting with a lapsed lease.

- 2026-10-04 (claude): **fast start and prune reworked after adversarial review** (supersedes the comment below):
  - Measured on Docker Desktop: a stopped container restarts with its files after `docker rmi --force` of its image; a running one makes the daemon refuse (409 "cannot be forced"). So:
    - the base is chosen when a sandbox is created, under the Workspace lock that base cleanup also takes, and is no longer part of the sandbox key;
    - a superseded base is deleted at once, unless a running container uses it (then the next sweep retries);
    - image removal uses `force` both in delete and in the prune.
  - Builders are containers our code creates with labels, wrapped in the stock `DockerHandle`. Containers started from a base inherit the image's labels.
  - Build: durable reserve/build/publish steps with a one-hour row lease. Builders take an org slot. Stale means a day old and behind. The current base is deleted after 30 unused days.
  - One cleanup path: the org sweep. The tip-check trigger and the job's own collect step are gone. The prune is a step of every sweep on Docker; the hourly scheduler is gone. Worker start schedules sweeps for `orgsNeedingSweep`.
  - The prune also removes labeled containers over an hour old with no row. Still unreachable, by design: a plain-chat-image container whose row was removed without destroying it. Our code keeps such rows as `destroy_failed` instead.
  - Proof in `workspace-sandbox-base-native.contract.test.ts` (6 tests, real Docker and Postgres, all pass locally). The remote is smart HTTP that requires a token, so the production token path is exercised:
    1. no clone from a base, three concurrent starts queue one build, one lease at a time, the builder counts toward the cap, and no token in the base image (git config, files, image config);
    2. a stale rebuild; an existing sandbox kept; a superseded base kept while a running container uses it and deleted once it stops, after which the stopped sandbox still resumes with its files;
    3. a gone base falls back to the chat image once (row marked failed, rebuild requested);
    4. a lost or expired lease stops and leaves nothing; no build at capacity;
    5. disk stays flat over three build/start/stop/delete cycles;
    6. the prune removes a dormant org's container, an orphaned image and an orphaned labeled container, and leaves the rest.
  - Timings (local, tiny repo): ready 0.9 s from a base vs 0.9–1.1 s without one (concurrent starts serialize on the Workspace lock).

- 2026-10-04 (claude): **fast start (option B) and host prune landed** (ADR-048 "Fast start" and "Cleanup"):
  - Base: a container of the chat image clones the Workspace repository and runs the Docker setup. `docker commit` turns it into `ctxpipe-workspace-base:<row>`, labeled `ai.ctxpipe.sandbox=workspace-base`, `ai.ctxpipe.store=<database hash>`, `ai.ctxpipe.base=<row>`, org and Workspace. The image holds no secret.
  - New conversations use stock `dockerSandbox({ image: <base> })`; stock bootstrap skips the clone. Existing conversations keep their container.
  - One build at a time per Workspace. Rebuilt when stale (a day old and behind, or more than 50 commits behind). Deleted when no conversation row started from it (superseded) or after 7 unused days (current). Relink and Workspace deletion delete it after the conversation containers.
  - Host prune (`docker-sandbox-host-prune` job): at most hourly, at worker start and from every sweep. It sweeps orgs with containers past 30 days, working from `provider_sandbox_id`. It removes labeled base images of this deployment whose row is gone; the row check happens at removal, so a build in flight is safe. Other deployments' images (same daemon, different database) and images a container uses are never touched.
  - Proven on real Docker and Postgres in `workspace-sandbox-base-native.contract.test.ts` (added to the "native sandbox ownership" lane). The remote is `git daemon` on the default bridge, so the test runs on Docker Desktop too:
    1. no clone when a base exists: the remote is removed and the start still succeeds from the base image;
    2. three concurrent new conversations queue exactly one build run, and three concurrent builds give `built`, `busy`, `busy`;
    3. a stale base is rebuilt (by commit count and by age), while an existing conversation keeps its container and moves to the tip;
    4. unused bases are deleted (superseded at once; current after 7 days);
    5. the prune removes a dormant org's 31-day-old stopped container and an unused labeled image, and leaves a recent container, a base in use, another deployment's image and an unlabeled image.
  - Measured locally (Docker Desktop, tiny repository on the bridge): sandbox ready 1.2 s without a base vs 1.1 s from one. The clone is all a Docker base saves, so the gain grows with repository size. The three concurrent starts without a base took 1.2/2.6/4.0 s, because the Workspace lock serializes creates (existing behavior).
  - Note for Compose/CDK: the worker builds bases, so it needs the same `DOCKER_HOST` / TLS and `SANDBOX_CHAT_IMAGE` as the backend (CDK already passes both).

- 2026-10-03 (claude, Compose part, after adversarial review): supersedes the isolation notes in the comment below.
  - **Isolation is stock policy plus one rule.** The `CTXPIPE-SANDBOX-EGRESS` private-range chain and the INPUT/gateway rejects are gone (they also missed the host's public address). Root cause fixed instead: `postgres` and `falkordb` are never published in any profile; host dev gets its `CTXPIPE_*` ports from the infra-only `infra-host-ports` socat forwarder, so dev commands and data are unchanged. `dind` keeps one rule: `iptables -t raw -I PREROUTING -d 169.254.169.254/32 -j DROP`, added before the stock entrypoint picks a backend (nf_tables first, legacy fallback; the raw table drops before Docker's rules and the kernel applies it whichever backend dockerd uses; an nf_tables rule does not flip the stock legacy detection). No cgroup v2 → caps skipped with a warning.
  - **One documented policy** (`architecture.mdx#chat-sandbox-network-policy`, linked from Docker and AWS pages): internet + backend model proxy/tool bridges; data stores never exposed (Compose: unpublished; AWS: security groups); metadata blocked; agent password + `icc: false`. Anything else published on a sandbox host is reachable. DNS: Compose sandboxes use 8.8.8.8/8.8.4.4 (Docker's substitute for the loopback 127.0.0.11), so service names do not resolve; AWS uses the VPC resolver. Docs warn that `sandbox_client_certs` is root-equivalent on the Docker host.
  - **Fail closed (plan step 5).** No more unsandboxed auto-fallback: without a lock, provider is Docker only if the daemon answers; locked `docker` pings too; otherwise 503 "Docker daemon at … is not reachable". `unsandboxed` only via `SANDBOX_PROVIDER=unsandboxed`, warned once (evlog) at server startup and on use. `workspaceChatRuntimeConfig` lost its unused `provider`. Tests: `sandbox-provider-discovery.test.ts` (real dockerode against a closed port and a fake `/_ping` daemon; evlog drain sees exactly one warning).
  - **Callback host.** Lookup/route failures → "The sandbox host X is not reachable yet" with `cause` (CDK host replacement), not "set SANDBOX_CALLBACK_HOST"; `::ffff:127.*` is loopback; bracketed IPv6 daemon hosts are resolved without brackets (real bug the new test found). Resolution and routing are an injected `CallbackNetwork` in the unit test. Compose passes `SANDBOX_CALLBACK_HOST` through again.
  - **Startup gating.** Backend/worker no longer depend on `dind` or `chat-sandbox-image`; until the image exists chat returns 503 "requires the initialized chat sandbox image". Docs note Compose will pull the GHCR image once that package is public.
  - **dind** bumped to `docker:29.8.2-dind@sha256:7dcdfc4a…`. Note: Docker 29 defaults to the containerd image store, so the chat image takes ~1.9 GB in `sandbox_docker` (vs ~1.4 GB).
  - **Live proof** (production backend image, fake model): backend up and `/.status` ok before the chat image existed, warm → 503 image missing; `dind` stopped → 503 "Docker daemon at tcp://dind:2376 is not reachable"; image built in DinD 29; two sandboxes, clone, sandbox→backend `/.status` 200, tool bridge 200, agent 401/200 at `http://dind:3276x`; callback host = backend's sandbox-net IP. From a sandbox: backend + github.com reachable; Postgres and FalkorDB container IPs time out, gateway :5432 and `host.docker.internal` :5432/:6379 refused, `postgres` name unresolvable, metadata dropped; resolv.conf 8.8.8.8/8.8.4.4. Gateway :6379 *was* reachable: another (developer `infra`) stack on the same Docker Desktop VM publishes FalkorDB there, which is exactly the "don't publish on a sandbox host" caveat. Restart `dind` → rule re-applied, conversation resumed its container and chatted. Worker-service cleanup destroyed 2/2. Infra profile in a separate project: data stores unpublished, Postgres and FalkorDB reachable on the forwarded host ports.
  - **Unproven:** full `pnpm start` (all five images) end to end: the codesearch image is ~5 GB and the shared Docker disk had ~4.6 GB free (it hit 100% twice during this work, restored each time). Needs a human run on a machine with ~15 GB free: `cp docker-compose.env.example .env`, set `AUTH_SECRET`, `MODEL_PROVIDER_API_KEY`, `pnpm start`, then a Workspace chat.

- 2026-10-03 (claude, Compose part): landed.
  - **Design.** `dind` is stock `docker:27-dind` (pinned digest), privileged, TLS via `DOCKER_TLS_CERTDIR` (CA in `sandbox_ca`, client certs in `sandbox_client_certs`, read-only in backend/worker), `/var/lib/docker` in `sandbox_docker`. `scripts/sandbox-dind/daemon.json` matches CDK (`cgroup-parent: /ctxpipe-sandboxes`, `icc: false`, json-file 3 × 10 MB; no systemd, so no live-restore). `scripts/sandbox-dind/entrypoint.sh` runs inside the image's `dind` wrapper, then `exec dockerd-entrypoint.sh`: INPUT reject from docker0 (daemon's own ports), a `CTXPIPE-SANDBOX-EGRESS` chain from DOCKER-USER (reject the uplink gateway, allow the uplink subnet, reject 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16), and the sandbox cgroup capped at 85% of dind's memory (its limit, else host) and 8192 pids. Both files are Compose `configs`. Backend/worker get `SANDBOX_PROVIDER=docker`, `SANDBOX_CHAT_IMAGE=ctxpipe-chat-sandbox:local`, `DOCKER_HOST=tcp://dind:2376`, TLS env from one YAML anchor. `dind` is only on a `sandbox` network; backend and worker are on `default` + `sandbox`.
  - **Chat image** is built inside DinD by the one-shot `chat-sandbox-image` (same dind image as CLI) from the checkout: `pnpm start` builds every other image from source too, it cannot skew from the backend, and it works before the GHCR package is public. Cached after the first run.
  - **Callback host.** The backend is now dual-homed, so "only non-loopback IPv4" would fail. `sandboxCallbackHost` (now async) defaults to the local address the kernel picks to reach the daemon (UDP connect, nothing sent); loopback daemon → provider-local defaults; unresolvable daemon → 503 naming `SANDBOX_CALLBACK_HOST`. On Fargate it is still the task IP.
  - **Finding:** separate networks alone did not isolate. Docker (29 on Desktop) routes to *published* container ports across networks, and the host gateway exposes every published port, so a sandbox opened Postgres (`ctxpipe`/`ctxpipe` owner). The egress chain closes both; a private-LAN Git server needs an explicit allow (documented).
  - **Also fixed:** `migrate` lacked `AUTH_SECRET`; modules it imports parse the app env, so `pnpm start` died at migrate.
  - **Deletion ledger:** `scripts/sandbox-runner/` (Dockerfile, Btrfs/quota `entrypoint.sh`, `model-relay-entrypoint.sh`, README), the `sandbox-model-relay` service, the runner build in `dind`/`chat-sandbox-image`, the backend's `hostname -i` entrypoint wrapper, volumes `sandbox_storage`/`sandbox_server_certs`, `CTXPIPE_SANDBOX_STORAGE_GIB`, `SANDBOX_MODEL_PROXY_HOST` (env.ts, chat wiring, contract test), the Btrfs note in `scripts/ci/test-suite.mjs`. No CI job built the runner.
  - **Proof** (project `ctxpipe-dind-proof`, host ports 15433/13000; production backend image; a proof script run inside the backend container; fake OpenAI server behind the real model proxy, no LLM): two conversations warmed → two DinD containers, each cloned the public fixture SHA; callback host `172.21.0.3` = backend's `sandbox` address (default-net `172.22.0.4`); sandbox → `http://172.21.0.3:3000/.status` 200; sandbox → per-run tool bridge 200 with tool result; agent URL `http://dind:3276x`, 401 without and 200 with the agent password; one full chat turn `"DinD reply."`, RUN_FINISHED, model request through the backend proxy. From a sandbox: backend sandbox-net reachable, github.com:443 reachable; Postgres by container IP and via host-published port, backend app-net, FalkorDB, dind :2376, other sandbox's agent port, 169.254.169.254 all refused. Cgroup cap 6.98 GB on a 7.7 GB VM, both sandboxes under it. DinD **recreate**: both containers `Exited`, re-warm resumed the same ids with files kept; DinD **restart** + one container deleted: conv A resumed and chatted, conv B re-created (new id). Backend mounts only the client certs (no `/var/run/docker.sock`). Cleanup run through the `worker` service's network/env: `instances: 2, destroyed: 2`, DinD left with 0 containers. UI/codesearch/worker images were not started (Docker disk was nearly full); everything created was removed afterwards.
  - Open: `docker:27` is old; bump the pinned dind image with the next Docker upgrade. Full `pnpm start` from a clean host (all images) not re-run here for disk reasons.

- 2026-10-03 (claude): **lifecycle landed** (shared with ticket 02; see ADR-048):
  - After 5 minutes idle, the `conversation-sandbox-sweep` OpenWorkflow job stops the container (`docker stop`, keyed by `provider_sandbox_id`) and sets the row to `stopped`. The next turn's stock `resume` starts it again with its files.
  - 30 days after last use, the sweep removes the container and the row. The same happens when the conversation is gone.
  - Starts are capped at 50 running per org, with an "at capacity" error.
  - MCP turns stop their container when the run ends.
  - Proven with real Docker and Postgres in `sandbox-lifecycle-native.contract.test.ts`. The Linux-only Docker chat contract in `workspace-chat-prepare-native.contract.test.ts` now also runs a full OpenCode turn after an idle stop, and an unattended turn that stops the container (CI only).
  - Still open for this ticket: labeled image/container prune for orphans and base images.

- 2026-10-03 (claude, CDK part, after adversarial review): `SandboxHostConstruct` (`packages/aws-cdk/src/internal/sandbox-host-construct.ts`) is wired into `CtxPipe`, always on, with optional `sandboxHost.instanceType` (Graviton only, others rejected at synth) / `dockerVolumeSizeGiB` (defaults from the sizing table). Design:
  - Single-instance ASG (AL2023 arm64, AMI resolved at launch so new AMIs do not replace the host on deploy), EC2 health checks, creation/rolling-update signals so `cdk deploy` waits for a ready host; IMDSv2 with hop limit 1; Session Manager, no SSH.
  - gp3 Docker volume at `/var/lib/docker` (deleted with the instance; sandboxes are disposable). `daemon.json`: TLS on 2376, `cgroup-parent` slice (MemoryMax 85%, TasksMax 8192), json-file 3 × 10 MB, `icc: false`, live-restore. iptables: containers cannot reach the host (other sandboxes' published agent ports, Docker API) or IMDS; agent ports are reachable inside the VPC, so this is kept next to the per-conversation agent password.
  - TLS: the two Secrets Manager secrets start as CloudFormation-generated placeholders (`GenerateSecretString`, never rewritten by CFN). The first host generates a CA, server and client certs, writes both secrets, discards the CA key; replacement hosts reuse them. The temp dir with keys is removed by an EXIT trap.
  - Address: the host registers `sandbox-host.ctxpipe.local` (Cloud Map, fixed instance id, TTL 10 s) after a TLS `_ping`; a delete-time custom resource deregisters it so `cdk destroy` can remove the service.
  - Chat image: `ghcr.io/ctxpipe-ai/chat-sandbox:<pinned tag>`, published multi-arch (amd64+arm64) from `scripts/chat-sandbox` in `deploy.yaml` next to the service images. The backend pulls it through the daemon on first use (`dockerImageId` in `sandbox-provider.ts`), so a release never replaces the host. Compose still builds it locally.
  - Backend/worker: `SANDBOX_PROVIDER=docker`, `SANDBOX_CHAT_IMAGE`, `DOCKER_HOST`, `DOCKER_TLS_VERIFY=1`, `DOCKER_CERT_PATH=/run/ctxpipe-docker-tls`. A non-essential `docker-tls` init container (same image) writes the client PEMs from Secrets Manager to a task volume the app mounts read-only (`dependsOn: SUCCESS`). The app containers keep their image CMD and never see the key in env. An entrypoint `exec "$@"` wrapper was not usable: overriding an ECS entryPoint drops the image CMD (Docker/OCI semantics), so it would have had to copy the CMDs again.
  - Backend (no new env vars): with a remote `DOCKER_HOST` and no `SANDBOX_CALLBACK_HOST`, the callback host is the local address the backend reaches the daemon from (the task IP on Fargate; 503 "sandbox host is not reachable yet" while the name does not resolve or route; superseded the earlier "single non-loopback IPv4" rule on 2026-10-03, Compose slice). Docker conversation sandboxes go through `withDockerAgentPort`: `ports.connect` returns the daemon's host instead of stock `localhost`, and the agent port requires `OPENCODE_SERVER_PASSWORD` (Basic `opencode:<password>`, from `conversationAgentPassword`) as on Vercel. Proven by `docker-agent-port-native.contract.test.ts` (real daemon over a TCP relay: URL host is the daemon host; 401 without the password, 200 with it).
  - Security groups: host ← backend SG and worker SG on 2376; host ← backend SG on 32768–60999 (published agent ports); backend SG ← host on 3000 and 32768–60999 (model proxy, tool bridges). The worker SG has no ingress. Host egress open (Git hosts, GHCR, NAT); data-store SGs still admit only the app SG.
  - Alarms (no actions, exposed as `ctxPipe.sandboxHostAlarms`): CWAgent `disk_used_percent` `/var/lib/docker` ≥ 80% (2 × 5 min), `mem_used_percent` ≥ 85% (3 × 5 min). Output `SandboxHostAutoScalingGroupName`.
- 2026-10-03 (claude, CDK synth diff, existing stack upgrading from the previous construct): **added (24)** host, backend and worker security groups with 5 SG ingress rules, ALB→backend-SG 3000 ingress/egress (CDK adds it because the backend service now has two SGs; same exposure as the app SG), 2 TLS secrets, Cloud Map service `sandbox-host`, deregistration custom resource + its policy (reuses the existing AwsCustomResource Lambda), instance role/policy/profile, launch template, ASG, 2 alarms, 2 log groups for the `docker-tls` init containers. **Changed in place**: backend and worker ECS services (`NetworkConfiguration` gains their SG, `DependsOn` the ASG; their Cloud Map services get the same `DependsOn`), backend/worker task definitions (new revision: init container, volume, env) and their execution role policies (read the client TLS secret). **Removed / replaced: nothing**; Aurora, Neptune, EFS, secrets with data and the VPC are untouched.
- 2026-10-03 (claude): `ready-for-human` (needs an AWS account or GitHub admin): (1) plan step 6 upgrade path — deploy the published construct with `examples/aws-cdk-self-host`, upgrade to this one, confirm no data loss and no manual steps, and that the deploy waits for the host signal; (2) boot script on real AL2023 (`/dev/xvdb` mount, docker.service drop-in, iptables rules, CloudWatch agent metrics feeding both alarms); (3) on Fargate, the address the backend routes to `sandbox-host.ctxpipe.local` from is its task IP and sandboxes reach it on 3000 and the tool-bridge ports (else set `SANDBOX_CALLBACK_HOST`); (4) first `deploy.yaml` run publishes `ghcr.io/ctxpipe-ai/chat-sandbox` for both architectures on Blacksmith, and the new GHCR package is made public (new packages start private); (5) preview-env `chat` against the example; (6) `cdk destroy` removes the Cloud Map service after the deregistration custom resource.

- 2026-10-02 (claude): from ticket 01. Stock `dockerSandbox` sets no container labels, ignores the requested name, and uses a random Docker name, so host cleanup cannot find our containers by label. Cleanup should work from `workspace_sandbox_instances.provider_sandbox_id` (the container id), and images we build for the Workspace base can carry our own labels. Local test runs leaked idle `node:22` containers this way; a host sweep needs the same id-based approach.

- 2026-10-02 (user): Docker fast start uses option B (per-Workspace base image built by our code, stock `dockerSandbox({ image })`, no patch). Same lifecycle as hosted: 5-minute idle stop, 30-day state, 50 per org, non-interactive runs stop immediately.

- 2026-10-02 (claude, ticket 07 docs): self-hosting docs do not yet mention chat sandboxes. Add the Docker sandbox host to `self-hosting/(getting-started)/architecture.mdx`, the Compose and AWS deployment pages, and the operations checks (disk cleanup, health).

- 2026-10-01 (ticket 07): when running the CDK example, also open the Workspace Graph pane — it is the only live check of the workspace graph queries on Neptune (#341).

- 2026-10-01: ticket 02 makes the git session branch the durable conversation state on hosted. Apply the same rule on Docker so self-host sandboxes are equally disposable (idle stop/destroy never loses work).

- 2026-10-01 (user): no opt-out from the sandbox host.

- 2026-10-01 (user): previous sizing too expensive for a host that does little; DinD acceptable. Moved to `t4g.medium`/`large`/`xlarge` with idle stop.

- 2026-10-01 (user): no instance preference beyond "optimal for the use case, balancing simplicity, cost and speed; ARM". Sizing table added.

## Resolution
