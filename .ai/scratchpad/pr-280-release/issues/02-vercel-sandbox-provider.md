# Vercel Sandbox for hosted chat

Status: needs-replan
Priority: P0
Owner: unassigned
Blocked by: 01
Created: 2026-10-01
Updated: 2026-10-02

## Context

> **2026-10-02 (user): the hosted provider is Vercel Sandbox, not Cloudflare.** Reasons: maturity, and we already use Vercel. CPU billed only while busy is a hard requirement. Close the `@tanstack/ai-sandbox-vercel` gaps with patches first, then raise upstream PRs after production launch:
> - start a new sandbox from a prepared snapshot (`source: snapshot`, snapshots and fork capabilities);
> - authenticated agent port (OpenCode server password + channel headers), because Vercel ports are public URLs;
> - process kill, measured against a real sandbox.
>
> The Cloudflare text below is history; the plan must be rewritten for Vercel before work starts.


Hosted ctxpipe runs on Railway. Today workspace chat there falls back to `unsandboxed`: OpenCode runs inside the shared backend container across tenants.

Decisions (user, 2026-10-01):

- Managed sandboxes run on **Cloudflare Sandboxes**. Railway Sandboxes' 100-per-environment cap is too low and Enterprise is not an option; no new vendors (Cloudflare is already used for R2 and is in the cost dashboard).
- Sandbox files are **not** the store of record: conversation work is **pushed to git** (the conversation's session branch). A sandbox can be wiped at any time.
- Unsandboxed is never the default on hosted.

Cloudflare facts (checked 2026-10-01):

- Limits are pooled per account: 1,500 vCPU / 6 TiB memory / 30 TB disk concurrent, raisable via support. Instance types `lite` (1/16 vCPU, 256 MiB), `basic` (¼, 1 GiB, 4 GB), `standard-1` (½, 4 GiB, 8 GB) … `standard-4` (4, 12 GiB, 20 GB). Image storage 50 GB per account. Snapshots ≤ 20 GB, kept 30 days.
- Sleep after `sleepAfter` idle (default 10 min) wipes files and processes; `keepAlive` prevents sleep.
- Pricing: memory $0.0000025/GiB-s, CPU $0.000020/vCPU-s (active only), disk $0.00000007/GB-s, plus Worker requests and Durable Object instances.
- The SDK is driven from a Worker through a Durable Object binding; the container reaches the outside world only over the network. Container scheduling policy is public beta.
- TanStack ships `@tanstack/ai-sandbox-cloudflare` (provider + coordinator + container runner), requiring `@tanstack/ai` ≥ 0.63 — available once ticket 01 upgrades the stack. Its capabilities: `durableFilesystem: false`, `killableProcesses: false`, ports via preview/tunnel.

## Goal

Every hosted workspace conversation (production and PR previews) runs in its own Cloudflare sandbox. The conversation's durable state is its git session branch; losing a sandbox costs a re-clone, never work.

## Acceptance criteria

- [ ] Hosted backend + worker use `SANDBOX_PROVIDER=cloudflare`; a missing or failing provider fails closed (no unsandboxed fallback on hosted).
- [ ] One sandbox per conversation; a sandbox that slept or was destroyed is recreated transparently on the next turn from the session branch.
- [ ] After every turn that changed files, the work is committed and pushed to the conversation's session branch through the backend broker (no push credential in the sandbox).
- [ ] OpenCode in the sandbox reaches only our model proxy and tool bridge, authenticated per run; the sandbox's OpenCode port is not reachable without a credential.
- [ ] Gateway Worker + Durable Object deploy from this repo in CI for production and each PR preview, isolated per environment.
- [ ] Resource use bounded: per-environment concurrency cap, `sleepAfter` aligned with keep-alive, sandboxes destroyed on conversation delete, orphan sweep reports zero after the browser suite.
- [ ] Latency recorded on pr-280: cold first answer (new sandbox + clone) and warm turn, against the ~5 s PRD target; cost per conversation-hour recorded.
- [ ] Conversation chrome shows only "Create PR" / "Show PR"; creating the PR squashes turn commits into one commit (proved by a Storybook play and a native git contract test).
- [ ] Preview-env `chat` and `files-publish` areas pass on pr-280.

## Plan

1. **Integration design (first, short).** Decide how the Railway backend drives Cloudflare sandboxes while keeping our `chat()` loop on the backend (ADR-044):
   - Preferred: a thin **gateway Worker + Sandbox Durable Object** we deploy, exposing the sandbox operations TanStack needs (create/ensure, exec/spawn with streaming, fs, ports, destroy) over authenticated HTTP/WebSocket, and a backend-side provider that implements TanStack's `SandboxProvider` against that gateway. Check first whether `@tanstack/ai-sandbox-cloudflare` already supports a remote (non-Worker) host; if so use it instead of writing our own.
   - Rejected unless the first option fails: moving `chat()` into the Cloudflare coordinator Durable Object (would move persistence, auth, and tools off our backend).
   Output: a short ADR (gateway shape, auth between backend ↔ Worker ↔ container, callback URLs). User review before phase 2.
2. **Gateway Worker.** New app (e.g. `apps/sandbox-gateway`) with the Sandbox DO class and container image config, `wrangler` deploy, per-environment names (`production`, `pr-N`). Auth: backend → Worker with a shared bearer per environment; Worker → DO by sandbox id = conversation id.
3. **Chat image.** Build the container image from `scripts/chat-sandbox/` (git, pinned `opencode-ai`, credential helper) for Cloudflare's registry; instance type `basic` to start (¼ vCPU, 1 GiB), configurable; measure and adjust.
4. **Backend provider + networking.** Implement/plug the provider; OpenCode in the container calls our model proxy and tool bridge on the backend's public URL with the existing per-run bearer tokens; backend reaches OpenCode through the gateway (container port proxied by the Worker), never a public unauthenticated URL.
5. **Git as durable state.** After each turn that changed the worktree, commit (message from the turn) and push to `ctxpipe/chat/<conversation>` via the existing conversation publication broker (backend fetches the delta and pushes; the sandbox holds read credentials only). On (re)create: clone the workspace repository, check out the session branch if it exists, run setup. Snapshots/forks are not needed for correctness; optionally use Cloudflare snapshots only to speed up the post-setup base.
6. **Publish UI.** Remove "Commit+Push" from the conversation chrome and its route/mutation; "Create PR" squashes the session branch's turn commits onto the default branch base into one commit before opening the PR; "Show PR" unchanged. Update Storybook plays and the preview-env `files-publish` area.
7. **Lifecycle + limits.** `sleepAfter` = keep-alive (30 min) or shorter if cost data says so; per-environment concurrency cap enforced before create (clear "capacity" error to the user); destroy on conversation/workspace delete; periodic orphan sweep via the gateway listing live sandboxes vs owner rows.
8. **Wire into hosted.** `SANDBOX_PROVIDER=cloudflare` + gateway URL/secret in `infra/module/ctxpipe/railway.tf` for backend + worker and PR previews; Cloudflare API token in CI secrets; deploy the Worker in `deploy.yaml` and `pr-deploy.yaml`; remove the unsandboxed fallback on hosted.
9. **Proof.** Provider contract tests against a real Cloudflare dev environment in a CI lane (fails, not skips, without credentials); preview-env `chat` + `files-publish`; sleep/destroy-mid-conversation test proving no work is lost; latency and cost numbers; orphan sweep.

## Decisions

- **Publish UI (user, 2026-10-01):** turn commits are pushed automatically, so the UI drops "Commit+Push" and keeps only "Create PR" / "Show PR". Creating the PR squashes the conversation's turn commits into one.
- **Instance type (user, 2026-10-01):** start on `basic` (1 GiB, ¼ vCPU); move to `standard-1` only if measurements require it.

## Open questions

None.

## Delegation brief

Read first: this ticket, ticket 01 (upgrade to `@tanstack/ai` 0.63 must land first), ADR-044, `sandbox-provider.ts`, `tanstack-workspace-chat.ts`, conversation publication code (`conversation-files-routes.ts`, publish broker), `scripts/chat-sandbox/`, `infra/module/ctxpipe/railway.tf`, `.github/workflows/deploy.yaml` and `pr-deploy.yaml`, the TanStack Cloudflare sandbox guide and `@tanstack/ai-sandbox-cloudflare` source, Cloudflare Sandbox SDK docs.

Phase 1 output (ADR draft) goes to the user before building; phases 2–9 follow once it is approved. Needs a Cloudflare account/API token with Workers + Containers (ask the user). Never fall back to unsandboxed on hosted.

## Comments

- 2026-10-02 (user decisions):
  - **Egress:** use Vercel's firewall allowlist (our backend, GitHub, whatever OpenCode needs), because the sandbox can read its Workspace read token.
  - **Lifecycle:** stop a sandbox after **5 minutes idle**. Keep a conversation's saved state **30 days** after last use. Cap each organization at **50 running sandboxes**.
  - **Non-interactive runs** (MCP `ctx_advisor` turns, Slack agent turns, semantic merge, anything not driven by a person in the UI) stop their sandbox **as soon as the run ends**, so they never hold a slot for the idle period.
  - **Credentials and target:** the Vercel access token is the GitHub Actions secret `VERCEL_ACCESS_TOKEN`; project `ctxpipe` in team `ctxpipe`. Deploy must pass it to the Railway backend and worker.

- 2026-10-02 (claude, ticket 07 docs): public docs now describe the target chat. Before closing:
  - add Cloudflare to the sub-processor table in `apps/docs/content/docs/(guide)/resources/data-processing.mdx`;
  - re-check `workspaces/chat.mdx` ("Where the agent runs", Create PR / Show PR, no Commit+Push) against what ships.

- 2026-10-01 (user): drop Commit+Push (keep Create PR / Show PR, squash on PR); start on `basic`.

- 2026-10-01 (user): no separate spike (Railway plan).
- 2026-10-01 (user): 100 Railway sandboxes too low; asked about Cloudflare. Comparison given (Cloudflare: pooled 1,500 vCPU / 6 TiB limits, ~7× cheaper memory, wipes files on sleep, Worker-only access, no process kill).
- 2026-10-01 (user): Cloudflare Sandboxes chosen — limits are enough, no new vendor, no Enterprise. Files are not a problem because work is pushed to git. Ticket rewritten for Cloudflare.

## Resolution
