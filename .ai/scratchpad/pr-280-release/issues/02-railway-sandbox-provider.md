# Railway Sandboxes provider for managed chat

Status: plan-review
Priority: P0
Owner: unassigned
Blocked by: 01
Created: 2026-10-01
Updated: 2026-10-01

## Context

Hosted ctxpipe runs on Railway. Today `SANDBOX_PROVIDER` is unset there and the backend has no Docker, so workspace chat falls back to `unsandboxed`: OpenCode runs inside the shared backend container across tenants. `"railway"` is listed in `SANDBOX_PROVIDERS` (`apps/backend/src/domain/workspaces/sandbox-provider.ts`) but has no implementation.

User decision (2026-10-01): managed uses [Railway Sandboxes](https://railway.com/sandboxes) via a TanStack provider we write. Unsandboxed is never the default or recommended.

Railway Sandboxes (GA): isolated Linux VMs, TS SDK `railway` (3.12.0). `Sandbox.create(template | source)`, `Sandbox.connect(id)`, `Sandbox.list()`, `exec(cmd, { cwd, env, timeoutSec, onStdout, onStderr })` with `detach()` / `kill(signal)`, `files.read/write/list/stat/exists/mkdir/rename/remove`, `fork()`, `checkpoint(name)` / `Sandbox.checkpoints()` / `deleteCheckpoint`, `destroy()`, templates (`Sandbox.template().withPackages().withEnv().workdir().run().build()`), `networkIsolation: "ISOLATED" | "PRIVATE"`, `domains: [{ port }]` (PRIVATE only, public HTTPS), `idleTimeoutMinutes`, `region`. Pro plan: 100 sandboxes/environment, up to 32 vCPU / 32 GB. Pricing ~$50/vCPU-month + $50/GB-month, billed by use.

No upstream `@tanstack/ai-sandbox-railway` exists; Sprites, Vercel, Daytona, Cloudflare, Blaxel providers are reference implementations of the same `SandboxProvider` contract.

## Goal

Workspace chat on hosted ctxpipe (production and PR previews) runs each conversation in its own Railway Sandbox through a stock TanStack provider, with no unsandboxed fallback on Railway.

## Acceptance criteria

- [ ] `railwaySandbox()` implements TanStack `SandboxProvider` (create, resume, destroy, snapshot/restore via checkpoint, fork) and advertises accurate `capabilities`.
- [ ] Provider passes TanStack's provider conformance tests (or our native sandbox contract tests if upstream has none) against a real Railway environment.
- [ ] Railway services set `SANDBOX_PROVIDER=railway`; on Railway, a missing/failed provider fails closed — no fallback to `unsandboxed`.
- [ ] One sandbox per conversation; warm resume after idle; `snapshot: "after-setup"` base reused across threads of a workspace revision.
- [ ] OpenCode in the sandbox reaches only the backend model proxy and tool bridge; it is not publicly reachable without a credential.
- [ ] No cloud or GitHub write credential enters the sandbox (existing broker rules).
- [ ] Idle sandboxes and checkpoints are cleaned up; a sweep reports zero orphans after the browser suite.
- [ ] Cold first answer and warm turn latency recorded on pr-280 vs the PRD target.
- [ ] Preview-env `chat` and `files-publish` areas pass on pr-280.

## Plan

1. **Provider package.** Implement `railwaySandbox(config)` as a small standalone package (e.g. `packages/tanstack-sandbox-railway`) shaped for upstream contribution: map `create`→`Sandbox.create` (template or checkpoint source), `resume`→`Sandbox.connect`, `destroy`→`destroy`, `snapshot`→`checkpoint`, `fork`→`fork`, process/fs/ports/env onto the SDK. Capabilities: `snapshots`, `fork`, `durableFilesystem`, `killableProcesses`, `ports` as proven by the contract tests; `networkPolicy: false` unless Railway exposes an allowlist.
2. **Chat image as a Railway template.** Build the sandbox template from the same inputs as `scripts/chat-sandbox/Dockerfile` (git, `opencode-ai@<pinned>`, credential helper). Version the template with the OpenCode pin so definition identity changes when it does.
3. **Networking + auth.** Establish while building the provider whether the backend can reach the sandbox on the private network and the sandbox can reach `backend.railway.internal`. Prefer PRIVATE network with backend → sandbox private addressing. If the only option is a public `domains` URL, protect OpenCode with a per-run secret header enforced by a tiny in-sandbox proxy or OpenCode's own auth, and record the choice in an ADR.
4. **Wire into product.** `SANDBOX_PROVIDER=railway` in `infra/module/ctxpipe/railway.tf` for backend + worker (and PR previews), Railway API token + environment id as secrets, region pinned next to Neon (ADR-029). Remove the unsandboxed fallback on Railway (`discoverSandboxProvider`), keep `unsandboxed` only as an explicit lock.
5. **Lifecycle + cleanup.** Map keep-alive (30 min) to `idleTimeoutMinutes`; extend `workspace-sandbox-cleanup.ts` to list provider sandboxes/checkpoints and destroy anything without a live owner row. Add a metric/log for orphan count.
6. **Proof.** Provider contract tests in a CI lane gated on a Railway test token (fail, not skip, when the token is missing in that lane); preview-env `chat`/`files-publish`; latency numbers; orphan sweep.
7. **Upstream.** Offer the provider to TanStack once stable.

## Decisions (made in the plan, 2026-10-01)

- **Quota:** Railway's sandbox limit (100 on Pro) is per environment, so PR previews do not consume production's quota. No extra cap.
- **Networking:** keep backend ↔ sandbox traffic on Railway's private network. Only if Railway cannot route private traffic to a sandbox, publish the OpenCode port on a Railway domain and require a per-run secret; record that in an ADR.
- **Location:** the provider lives in this repo as a small package first, then is offered upstream to TanStack.

## Delegation brief

Read first: this ticket, ticket 01's ledger, `sandbox-provider.ts`, `tanstack-workspace-chat.ts` (provider selection + `defineSandbox`), `workspace-sandbox-cleanup.ts`, `scripts/chat-sandbox/`, `infra/module/ctxpipe/railway.tf`, the `use-railway` skill, and one upstream provider (`@tanstack/ai-sandbox-sprites` or `-daytona`) as a template.

Build the provider directly (no separate spike). Record create / checkpoint-restore / fork / exec latency and the networking answer in `## Comments` as soon as known. Needs a Railway API token scoped to the pr-280 environment (ask the user). Never fall back to unsandboxed on Railway.

## Comments

- 2026-10-01: the three open questions (preview quota, public vs private networking, package location) are decided in the plan above rather than left to the user.

- 2026-10-01 (user): no separate spike — build the provider directly. Plan updated.

## Resolution
