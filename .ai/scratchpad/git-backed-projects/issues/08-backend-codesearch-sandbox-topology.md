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

### Round 2 (human, 2026-08-14) — clone latency, self-contained default, Railway must sandbox, `gh`, in-process only on self-host

Human answers (mapped onto the previous Q4–Q5 plus extra):

- **Workspace:** clone **backing repo only** + codesearch tools. Ask whether `gh` with read scope from the current GitHub integration can also live in the sandbox.
- **Host worktree for chat isolation:** not required if the in-sandbox clone is fast enough. (Was a workaround for assumed slow full checkouts.)
- **Keep backend ≠ codesearch.** Still need a concrete sandbox runtime, not only “they are separate.”
- **Default must be self-contained.** Do not assume host Docker we do not control. Do not care whether the primitive is socket / DinD / `sbx` as a brand; **arguably should not be a sibling of the service container.** If several options exist, pick on **boundary strength**, **startup latency**, other NFRs.
- **Railway:** must be **100% sure of a sandbox** (overrides the earlier “skip Railway unless TanStack already has it”).
- **Self-host:** do the maximum to run an isolated sandbox; **if there is no way, default to in-process** (`localProcessSandbox`).

Facts recorded in [sandbox clone latency and providers](../assets/sandbox-clone-latency-and-providers.md):

- Shallow clone of this repo **~1 s / 30 MB**; kubernetes/kubernetes depth-1 **~10 s / 419 MB** on the research VM. Backing-repo-only means kubernetes-scale is **not** on the chat clone path.
- TanStack: depth-1 default, `reuse: 'thread'`, snapshot after setup when the provider can.
- No first-party `railwaySandbox`; Railway SDK is wrapable as a custom `SandboxProvider`.
- `gh` + `GH_TOKEN` from a **narrowed** installation token is possible; current `getInstallationToken` is full App permissions (includes write). Token TTL 1 hour.

### Round 3 (human, 2026-08-14) — local worktree, installation-wide `gh`, Railway DinD-in-sandbox, Fargate as self-host

- **Q7 accepted:** Compose default = `dockerSandbox` → **DinD sidecar**; `sbx` via env when hypervisor exists; `localProcessSandbox` last.
- Clone latency OK for chat; worried it limits **other** sandbox uses. Asked: host `git worktree` + `defineWorkspace({ source: { type: 'local', path } })`.
- `gh`: mint read-only **on the fly**; **not** repo-scoped — agent needs **cross-repo** access.
- Why a custom Railway TanStack provider instead of the same DinD sidecar, inside a Railway sandbox?
- Fargate: “we already run Docker containers”; treat AWS as another self-host with the same DinD + in-process fallback.

Facts (same asset): `type: 'local'` is provider-pre-populated; dockerSandbox does not bind-mount; worktree is not cheap across an isolation boundary. Railway **services** cannot DinD; Railway **sandboxes** are VMs that already include Docker. Fargate forbids privileged / DinD. Read-only installation tokens can omit `repositories` for install-wide access.

### Round 4 (human, 2026-08-14) — git workspace + reuse, project-repo `gh`, detect/fallback + env lock

- **Workspace:** `githubRepo` / `gitSource` clone into the sandbox. Host worktree is not the isolation path. **Requirement:** good sandbox **reuse**; start time matters.
- **`gh`:** read-only, but **not** the whole GitHub App installation. Scope to **all Project repos** (backing + attached) including issues, PRs, etc. GitHub allows `permissions` + `repositories` (max 500 names) on the installation-token mint; names must already be in the installation.
- **Providers:** detect/fallback of what the host can run; **add a custom Railway Sandboxes `SandboxProvider`**. Env can **lock** a provider — if locked and it does not work, **fail** (no in-process fallback). ctxpipe deploy templates (CDK, Terraform) should configure a real sandbox **as much as the platform allows**.

Still open for this ticket: how reuse is keyed (per-thread vs project-level snapshot/fork), and what the CDK Fargate template locks when DinD is impossible.
