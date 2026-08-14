# Backend, codesearch, and sandbox-runner topology

Type: grilling
Status: claimed
Blocked by: 01, 05, 06, 17

## Question

With knowledge moving to git and chat running through TanStack `withSandbox` (see [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md)), how many **deployables** do we keep, and **where does `dockerSandbox()` get a Docker daemon**?

Do **not** propose spawning `opencode serve` or `docker run` ourselves. Chat isolation is a TanStack `SandboxProvider`. Options to grill (add or kill with a named failure mode):

1. **Merge backend and codesearch**, and give that process a Docker API (socket or sibling). `withSandbox` + `dockerSandbox` runs next to Zoekt. Cost: extra instances duplicate in-memory Zoekt; Docker socket is root-equivalent on Compose.
2. **Keep them separate.** Backend (the process that calls `chat()`) gets Docker for `dockerSandbox`. Codesearch keeps `/data` for Zoekt. Independent disks. Railway: backend still cannot mount a volume *and* typically has no Docker API.
3. **Keep them separate, shared disk on one machine.** Already looking dishonest on Railway (one volume per service, no replicas). Unlikely to be the chat isolation story now that the agent tree is inside the TanStack container.
4. **Backend calls `withSandbox`; provider is not `dockerSandbox` on hosted.** Compose uses `dockerSandbox`. Railway/Fargate use a TanStack provider we did not write OpenCode for — either an official cloud provider (Daytona / Vercel / Sprites) or a small `SandboxProvider` adapter over Railway Sandboxes / ECS `RunTask` that still goes through `withSandbox`. **Not** a third service that shells OpenCode.

Hold:

- Prefer simplicity; we are not designing a mesh.
- Chat must not write the host main tree — TanStack clones into the sandbox ([Workspace](https://tanstack.com/ai/latest/docs/sandbox/workspace)).
- Freshness of codesearch clones uses **stored revision state**, not a git remote on the hot path (see [Project revision and derived-store freshness](11-project-revision-and-freshness.md)).
- Reopening [ADR-008](../../../memory/decisions/ADR-008-codesearch-zoekt-orchestration.md) is allowed if we merge; say so.

Recommend one option. Name each rejected option's killing failure mode. "It might be nice later" is not a reason to keep a deployable.

## How files get into the sandbox (not a shared disk)

The sandbox does **not** mount codesearch `/data` and does **not** share the host checkout.

TanStack `defineWorkspace({ source: githubRepo({ repo, ref }) })` (or `gitSource`) **clones the backing git repo into the sandbox container**. The agent’s working tree is that clone, inside the sandbox. Codesearch keeps its own `/data/repo-cache` + Zoekt. Chat talks to codesearch over HTTP for attached-repo search.

Write disposition of that in-sandbox tree is [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md), not this ticket.

## Docker socket vs DinD vs `dockerSandbox()`

`dockerSandbox()` is TanStack’s provider. It speaks a **Docker API** and starts a container. We do not `docker run` OpenCode ourselves.

Three ways to expose that API — they are not the same thing:

| Mechanism | What it is | Typical use |
| --- | --- | --- |
| **Docker socket** (`/var/run/docker.sock`, or `DOCKER_HOST=unix://…`) | The host daemon’s Unix socket. Mount it into the backend container → backend starts **sibling** containers on the **host** daemon. Root-equivalent on that host. **Not** DinD. | Compose / self-host / any VM that already runs Docker |
| **DinD** | A Docker **daemon inside a container**. `dockerSandbox` talks to *that* inner daemon. Usually needs privileged. Isolated from host containers; still a Docker API. | Sidecar where the platform allows privileged; **not** Railway/Fargate |
| **Remote `DOCKER_HOST`** | TCP (or SSH) to a Docker engine that is not on the same machine. Still `dockerSandbox()`. | Hosts with no local daemon, if the operator provides an engine |

`sbxSandbox()` is Docker Sandboxes **microVMs** (`sbx` CLI + hypervisor). Different export. Not DinD and not “the socket.”

**Railway / Fargate today:** no host socket, no privileged DinD. TanStack has **no** first-party `railwaySandbox`. A Railway adapter is a future provider, not v1.

**“Docker sandbox on any hosting option”** therefore means: use `dockerSandbox()` wherever a Docker API exists (socket, DinD sidecar, or remote `DOCKER_HOST`). It does **not** mean DinD magically appears on Railway. Where there is no Docker API and no other provider is configured, project chat with sandbox is unavailable — no host OpenCode fallback.

## Comments

### Round 1 (human, 2026-08-14) — did not accept the first Q1–Q3 as-is; asked how files and Docker actually work

Locked leanings from that reply:

- Multiple providers stay a **seam**. **Docker is the default** (`dockerSandbox`; DinD only as one way to supply the Docker API).
- Want docker sandbox on **any** hosting option (more/custom hosts later). Honest constraint: needs a Docker API; Railway/Fargate have none locally.
- Provider **controlled by env** (operator/environment difference — legitimate).
- Railway Sandboxes: nice-to-have **only if** TanStack already supports it and it is easy to enable. **It does not** (`railwaySandbox` does not exist). **Skip for v1.** More providers later, including a custom Railway adapter if we choose.

Draft topology to confirm next round: keep backend ≠ codesearch (ADR-008). Backend calls `chat()`. Default provider `dockerSandbox` via env. Docker API from socket / DinD sidecar / remote `DOCKER_HOST` where the platform allows. Do not merge with codesearch. Do not share Railway volumes. Ops agents stay unsandboxed.
