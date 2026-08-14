# Sandbox clone latency, provider NFRs, Railway adapter, `gh` CLI

Facts for [Backend, codesearch, and sandbox-runner topology](../issues/08-backend-codesearch-sandbox-topology.md). Not a product decision.

Measured 2026-08-14 on the cloud-agent VM (public GitHub HTTPS).

## Clone is not the kubernetes-scale problem if workspace = backing repo

TanStack `githubRepo` / `gitSource` default to `--depth 1 --single-branch` ([Workspace](https://tanstack.com/ai/latest/docs/sandbox/workspace)). Cold start is clone + provider create + optional `setup`. Warm start is resume → restore snapshot → else create ([Lifecycle](https://tanstack.com/ai/latest/docs/sandbox/lifecycle)).

If the sandbox clones **only the Project backing repo** (knowledge + connectors), kubernetes-scale trees stay on codesearch. They are not on the chat clone path unless someone *backs* a Project with such a repo.

Measured shallow clones:

| Tree | Wall clock | On-disk after clone |
| --- | ---: | ---: |
| `ctxpipe-ai/ctxpipe` (`--depth 1 --single-branch`) | **0.98 s** | **30 MB** |
| `kubernetes/kubernetes` (same flags; 31 300 files at tip) | **10.3 s** | **419 MB** |

GitHub’s `size` field for kubernetes/kubernetes at measure time was **1 510 679 KB** (~1.44 GiB) — that is GitHub’s stored repo size, not the shallow working tree. A 2020 kubernetes-autoscaler note put full clone ~750 MB download / ~950 MB disk and depth-1 ~50 MB / ~250 MB ([PR 3420](https://github.com/kubernetes/autoscaler/pull/3420)); today’s shallow working tree on this VM was 419 MB in 10 s.

`pnpm install` / image pull / VM boot dominate over clone for app repos. A markdown knowledge repo should skip package `setup`.

TanStack already pays clone once per sandbox instance when `lifecycle.reuse: 'thread'` and snapshots exist (`snapshot: 'after-setup'` on snapshot-capable providers). Subsequent turns skip clone.

## Provider NFR sketch (official TanStack + Railway SDK)

Isolation and host needs from [Providers](https://tanstack.com/ai/latest/docs/sandbox/providers) and [Railway Sandboxes](https://docs.railway.com/sandboxes):

| Provider | Boundary | Self-contained in the deploy? | Sibling of the app container? | Snapshots | Notes |
| --- | --- | --- | --- | --- | --- |
| `localProcessSandbox` | **None** (host process) | Yes | N/A (same machine/process tree) | No | TanStack: trusted/dev only |
| `dockerSandbox` + **host socket** | Linux container, **host kernel**; socket is **root-equivalent** ([Docker attack surface](https://docs.docker.com/engine/security/#docker-daemon-attack-surface)) | No — needs host daemon | **Yes** | Docker commit yes | Not a strong untrusted-code boundary |
| `dockerSandbox` + **DinD sidecar** | Nested daemon; usually **privileged** | Yes if the platform allows privileged | No (sidecar, not host socket) | Docker commit yes | Compose-possible; Railway/Fargate no |
| `sbxSandbox` | **MicroVM**, own kernel + daemon | Yes **if** hypervisor (`sbx` CLI, KVM/Hyper-V/Virtualization.framework). Socket is not enough | No | **No** snapshot/fork | Stronger than a container |
| Daytona / Vercel / Sprites | Remote VM/microVM | No — third-party control plane + API key | No | Varies | Assumes infra we do not run |
| **Railway Sandboxes** (no first-party TanStack export) | Railway **VM**; default `ISOLATED` = outbound NAT, no private net to other services | Yes **on Railway** (`RAILWAY_API_TOKEN` + `RAILWAY_ENVIRONMENT_ID`) | No | Templates, checkpoints, forks | Priority Boarding; API may break. Idle timer **ignores in-VM processes** (only `exec`/SSH reset it). Hobby 50 / Pro 100 concurrent per environment. No public SLA for create latency. |

There is **no** `railwaySandbox()` in TanStack. A custom object implementing `SandboxProvider` / `SandboxHandle` (`create` / `resume` / `destroy` + `capabilities()`) is the documented seam ([Providers](https://tanstack.com/ai/latest/docs/sandbox/providers), [durability example](https://tanstack.com/ai/latest/docs/sandbox/durability)). Railway’s TypeScript SDK (`railway` package) exposes `Sandbox.create`, `exec`, `files`, `connect`, `fork`, `checkpoint`, templates — enough to wrap, not a drop-in.

## `gh` CLI + current GitHub App token

Yes, it is possible. It is not free.

- ctxpipe already mints **installation access tokens** via `getInstallationToken` (`apps/backend/src/models/github-installation.ts`) using Octokit `auth({ type: "installation" })`. That token has **all permissions the App was granted**, not a read-only subset. The App is used for clone **and** write (MCP config PRs need branch/commit/PR).
- GitHub’s create-installation-token API can **narrow** `permissions` and `repositories` on mint; the token cannot exceed the App’s grant. Tokens **expire in 1 hour** ([Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).
- `gh` accepts that token as `GH_TOKEN` (GitHub documents this for Actions with `actions/create-github-app-token`; CLI maintainers say `GH_TOKEN` / `gh auth login --with-token`). `gh` does **not** mint App tokens itself from a PEM.
- Putting `GH_TOKEN` in the sandbox is giving the **agent** those GitHub permissions. A full installation token in the sandbox can write every installed repo. A sandbox-only token should be minted **read-only** (and preferably repo-scoped). Never put the App private key in the sandbox.
- Long-lived `reuse: 'thread'` sandboxes need a refresh before the hour is up (re-inject secret on resume).

TanStack workspace `setup` can `apt`/`install` `gh`; `createSecrets` injects env at create/resume and is not persisted in the snapshot ([Workspace](https://tanstack.com/ai/latest/docs/sandbox/workspace)).
