# Docker sandboxing for self-hosters (Compose + AWS CDK)

Status: plan-review
Priority: P0
Owner: unassigned
Blocked by: 01
Created: 2026-10-01
Updated: 2026-10-01

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
- [ ] Cleanup: containers removed on destroy and idle expiry; snapshot images deleted when their last owner row goes; a periodic labelled prune catches orphans; disk stays flat across repeated browser-suite runs.
- [ ] Sandboxes reach only what they need (backend model proxy + tool bridge, Git host); documented, not enforced beyond stock policy.
- [ ] `examples/aws-cdk-self-host` deploys and passes preview-env `chat` against it (manual e2e, recorded).
- [ ] Self-hosting docs updated (Compose + CDK sandbox sections, unsandboxed marked last-resort).

## Plan

1. **Compose simplification.** Replace the custom runner with stock `docker:dind` (TLS on via `DOCKER_TLS_CERTDIR`, named volume for `/var/lib/docker`, `daemon.json` with `cgroup-parent` + log rotation). Backend/worker use `DOCKER_HOST=tcp://dind:2376` + client certs. Build the chat image inside dind at startup (keep the existing `chat-sandbox-image` step if still needed). Remove `sandbox-model-relay`; sandboxes reach the backend through the dind network / `hostGateway`. Prove: two chats, restart dind, chats resume or re-create cleanly.
2. **Cleanup owner.** Label every sandbox container and snapshot image with org/workspace/conversation ids. Extend `workspace-sandbox-cleanup.ts`: destroy idle sandboxes past keep-alive, delete snapshot images whose owner rows are gone, then `docker container prune` / `image prune` filtered by our labels. Run it from the existing periodic workflow. Prove with a native contract test that creates, snapshots, forks, expires, and asserts nothing labelled remains.
3. **CDK sandbox host construct.** Add `SandboxHostConstruct` to `packages/aws-cdk/src/internal/`: single-instance ASG (self-healing) on the Graviton instance for the `size` profile (table above, overridable), gp3 root + data volume for `/var/lib/docker`, user data installing Docker with TLS and the same `daemon.json`, certs generated once into Secrets Manager, security group allowing 2376 only from backend/worker and sandbox → backend ports. Inject `SANDBOX_PROVIDER=docker`, `DOCKER_HOST`, and certs into backend/worker task definitions. CloudWatch disk + memory alarms. Default on; no new required props.
4. **Backend wiring.** Provider selection reads the configured daemon; remove unsandboxed auto-fallback when a daemon is configured but unreachable (fail closed). Keep `unsandboxed` reachable only by explicit `SANDBOX_PROVIDER=unsandboxed`, with a startup warning.
5. **Upgrade path test.** Deploy the previous published construct in a sandbox AWS account, then upgrade to this one: no data loss, no manual steps. Record in the ticket.
6. **Docs + changeset.** Self-hosting docs for Compose and CDK sandboxing; minor changeset for `@ctxpipe/aws-cdk`; ADR for "self-host sandbox = stock dockerSandbox on DinD/EC2" (feeds ticket 08).

## Instance sizing (user, 2026-10-01: ARM, cheap — the host does little work)

The host mostly holds idle sandboxes; CPU bursts are short (clone, grep, tests) and model calls run elsewhere. Burstable Graviton (`t4g`, unlimited credits) is the cheapest fit; memory is the real limit (~0.3–0.5 GiB per active sandbox). Prices are us-east-1 on-demand, approximate, including the gp3 Docker volume.

| `size` | Instance | vCPU / RAM | Docker volume | ~Cost/month | Resident sandboxes (est.) |
| --- | --- | --- | --- | --- | --- |
| small | `t4g.medium` | 2 / 4 GiB | 30 GB | ~$27 | ~6 |
| medium | `t4g.large` | 2 / 8 GiB | 50 GB | ~$53 | ~14 |
| large | `t4g.xlarge` | 4 / 16 GiB | 100 GB | ~$106 | ~30 |

Keep memory low by stopping (`docker stop`) sandboxes idle for 10 minutes and resuming with `docker start` on the next turn, and destroying them after the 30-minute keep-alive. Overridable via optional props. ARM means the chat image is built `linux/arm64`. Validate with the browser suite (ticket 06) before release.

## Decisions

- No opt-out: the CDK construct always creates the sandbox host; sandboxing is a safety feature (user, 2026-10-01).
- Compose default is DinD (privileged sidecar); the backend never mounts the host Docker socket (user, 2026-10-01).

## Open questions

None.

## Delegation brief

Read first: this ticket, ticket 01's ledger, `docker-compose.yml`, `scripts/sandbox-runner/`, `scripts/chat-sandbox/`, `sandbox-provider.ts`, `workspace-sandbox-cleanup.ts`, `workspace-chat-docker-policy.ts`, `packages/aws-cdk/src/internal/*`, `packages/aws-cdk/README.md`, `.cursor/skills/aws-cdk/`, ADR-015 (Compose profiles).

Do not add TanStack patches or an application-level sandbox registry. Keep construct changes backwards compatible. Report: deletion ledger, cleanup proof output, CDK synth diff summary, upgrade-path result.

## Comments

- 2026-10-01: ticket 02 makes the git session branch the durable conversation state on hosted. Apply the same rule on Docker so self-host sandboxes are equally disposable (idle stop/destroy never loses work).

- 2026-10-01 (user): no opt-out from the sandbox host.

- 2026-10-01 (user): previous sizing too expensive for a host that does little; DinD acceptable. Moved to `t4g.medium`/`large`/`xlarge` with idle stop.

- 2026-10-01 (user): no instance preference beyond "optimal for the use case, balancing simplicity, cost and speed; ARM". Sizing table added.

## Resolution
