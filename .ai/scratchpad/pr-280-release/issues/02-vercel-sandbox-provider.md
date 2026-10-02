# Vercel Sandbox for hosted chat

Status: ready
Priority: P0
Owner: unassigned
Blocked by: 01
Created: 2026-10-01
Updated: 2026-10-02

## Context

Hosted ctxpipe runs on Railway. Today hosted workspace chat falls back to `unsandboxed`: OpenCode runs inside the shared backend container across tenants. This ticket moves every hosted conversation into its own Vercel Sandbox (Firecracker microVM). Architecture: [ADR-048](../../../memory/decisions/ADR-048-native-postgres-sandbox-ownership.md).

Decisions (user, 2026-10-02):

- **Vendor:** Vercel Sandbox. Reasons: maturity, an existing vendor, CPU billed only while busy (hard requirement), microVM isolation, durable files, 10,000 concurrent sandboxes.
- **Provider gaps** in `@tanstack/ai-sandbox-vercel` 0.2.5 are closed with **temporary patches**. Each gets an upstream PR **after production launch**:
  1. start a new sandbox from a snapshot (`source: { type: 'snapshot' }`), and enable snapshots and fork;
  2. authenticated agent port: OpenCode server password in the sandbox, `Authorization` header returned by `ports.connect`, because `sandbox.domain(port)` is a public URL;
  3. process kill: measure Vercel's server-side kill against a real sandbox, enable `killableProcesses` only if it stops the whole process group.
- **Egress:** Vercel firewall allowlist (our backend, GitHub, what OpenCode needs).
- **Lifecycle:**
  - stop after 5 minutes idle;
  - keep saved state 30 days after last use;
  - at most 50 running sandboxes per organization;
  - non-interactive runs stop their sandbox as soon as they finish.
- **Publish UI:** turn commits are pushed automatically; the UI keeps only Create PR (squashes turn commits) and Show PR; Commit+Push is removed.
- **Credentials:** GitHub Actions secret `VERCEL_ACCESS_TOKEN`, team `ctxpipe`, project `ctxpipe`. Deploy passes them to the Railway backend and worker. Region `iad1` (next to Railway and Neon).
- Unsandboxed is never used on hosted; a missing or failing provider fails closed.

## Goal

Every hosted conversation (production and PR previews) runs in its own Vercel sandbox:
- it starts from the Workspace base;
- it resumes with its files after idle;
- it never exposes an unauthenticated agent port;
- it never holds a slot longer than needed.

## Acceptance criteria

- [ ] Hosted backend and worker select the Vercel provider; without `VERCEL_ACCESS_TOKEN` they fail closed.
- [ ] The three patches exist, are minimal, and are listed in the patch ledger with removal conditions.
- [ ] A new conversation starts from the Workspace base (no clone in the first turn). An idle-stopped conversation resumes with its files.
- [ ] The agent port rejects requests without the password (contract test against a real sandbox).
- [ ] The firewall allowlist is applied; a request to a non-allowlisted host fails (contract test).
- [ ] Lifecycle:
  - idle stop at 5 minutes;
  - non-interactive runs stop immediately;
  - 30-day state deletion;
  - 50-per-org cap with a clear "at capacity" error.
  
  Each is proven by a test.
- [ ] Cancel stops the agent: by kill if proven, otherwise by stopping the sandbox.
- [ ] Each turn that changed files is committed and pushed to the session branch through the backend broker. Create PR squashes; Show PR links; Commit+Push is gone (Storybook play + native git contract).
- [ ] Deploy:
  - `deploy.yaml` and `pr-deploy.yaml` pass the token, team and project to Railway backend and worker;
  - previews tag their sandboxes by environment;
  - a PR close cleans them up.
- [ ] Latency and cost recorded on pr-280: first answer in a new conversation, resumed conversation, warm turn, against the ~5 s target.
- [ ] Docs: `resources/data-processing.mdx` lists Vercel as a sub-processor; `workspaces/chat.mdx` matches what ships.
- [ ] Preview-env `chat` and `files-publish` areas pass on pr-280.

## Plan

1. **Provider wiring (after ticket 01's upgrade).**
   - Add `@tanstack/ai-sandbox-vercel`.
   - `sandbox-provider.ts` selects `vercel` when configured. Config: token, team, project, region.
   - Chat image as a Vercel custom image: pinned `opencode-ai`, git credential helper.
2. **Patch 1: start from snapshot.**
   - Provider config `snapshot?: string` passed as `source`, mirroring the Upstash provider.
   - Snapshots and fork capabilities through `sandbox.snapshot()` / `Sandbox.fork`.
   - Proof: contract test creates a base, starts two sandboxes from it, and finds the clone already present.
3. **Patch 2: authenticated port.**
   - Generate an OpenCode server password per sandbox, set it in the sandbox env, and return `{ url, headers: { Authorization } }` from `ports.connect`.
   - Proof: an unauthenticated request is rejected; the adapter connects.
4. **Patch 3: kill.**
   - Measure `Command.kill` on a process group (`tail -f` child) against a real sandbox.
   - Enable only if it is clean; otherwise our cancel path stops the sandbox.
5. **Workspace base (shared with ticket 03).**
   - A base builder creates a sandbox from the Workspace repository, runs setup, and snapshots it with no expiry while in use.
   - Recorded in the sandbox table, rebuilt when stale, deleted when unused.
6. **Egress allowlist and GitHub token in the firewall.**
   - Apply Vercel's network policy at create, at resume, and on token refresh (our own `Sandbox.create` / `sandbox.update`; no patch).
   - Allowlist: backend origin, `github.com`, `api.github.com`, `codeload.github.com`, and what OpenCode needs (to be measured).
   - `github.com` / `api.github.com` rules add the session's GitHub read token as the `Authorization` header; the token never enters the sandbox.
   - Token rotation: keep a token for 10 minutes, recorded on the sandbox row. When it is older, mint a fresh one (no Octokit cache), update the rule off the critical path, and revoke the old token after ~30 s. Revoke on sandbox stop.
   - Proof: real-Vercel contract for a private-repository clone with no credentials in the sandbox, plus rotation and revocation.
7. **Lifecycle.**
   - Idle timeout 5 minutes. Persistent sandboxes with `keepLastSnapshots: 1` and 30-day expiry.
   - The org cap is counted from our sandbox table under the Workspace lock before create.
   - Non-interactive callers (MCP, Slack) call stop in `finally`. Semantic merge no longer uses a sandbox (ticket 01).
8. **Git as durable state + publish UI.** Per-turn commit and push via the broker. Squash on Create PR; remove Commit+Push (route, mutation, chrome, stories).
9. **Deploy.** Pass the GitHub secret through `deploy.yaml` and `pr-deploy.yaml` (and Terraform variables if that's where Railway env lives). Preview tag plus cleanup on PR close.
10. **Proof.**
    - Real-Vercel contract lane: fails, never skips, without credentials.
    - Preview-env `chat` + `files-publish`.
    - Idle-stop and resume mid-conversation without losing work.
    - Latency and cost numbers.

## Open questions

None.

## Delegation brief

Read first:
- this ticket, ticket 01 (upgrade lands first), ADR-044, ADR-048;
- `sandbox-provider.ts`, `tanstack-workspace-chat.ts`, `workspace-sandbox-cleanup.ts`, `sandbox-instance-store.ts`;
- conversation publication (`conversation-files-routes.ts`, `conversation-publish.ts`);
- `scripts/chat-sandbox/`, `.github/workflows/deploy.yaml`, `pr-deploy.yaml`, `infra/module/ctxpipe/railway.tf`;
- `@tanstack/ai-sandbox-vercel` and `@vercel/sandbox` source, Vercel Sandbox docs (persistence, snapshots, firewall, pricing).

Keep each patch minimal and listed with its removal condition. Never fall back to unsandboxed on hosted.

## Comments

- 2026-10-03 (user): put the GitHub read token in the Vercel firewall rule. Keep a token for 10 minutes rather than refreshing every turn; refresh off the critical path. Measured: header added to HTTPS from Node and curl; not visible in the sandbox; rule update 0.42 s, new value live 0.35 s later.

- 2026-10-03 (claude): **measured against real Vercel sandboxes** (CI lane "Hosted sandbox (Vercel) contracts", all five pass):

  | Step | Time |
  | --- | ---: |
  | Create a sandbox | 0.25–0.7 s |
  | Stop a persistent sandbox (saves state) | 3.2–4.3 s |
  | Resume it and read a saved file | 1.6–1.8 s |
  | Snapshot a prepared base | 2.1 s |
  | Start a new sandbox from that snapshot | 0.9 s |
  | Install OpenCode 1.18.34 with npm | 11.3 s |
  | OpenCode serving after spawn | 1.8 s |

  - The egress allowlist works: `github.com` answers; other hosts fail DNS (`ENOTFOUND`).
  - The agent port answers 200 with the OpenCode password and 401 without it.
  - `Command.kill` stops the command's child process too, so hosted cancel can kill the agent (enable `killableProcesses`); no patch is needed for kill.
  - So the three planned patches look unnecessary: snapshot start and port auth fit in our own `Sandbox.create` + stock `VercelHandle`, and kill already works. The base snapshot should carry OpenCode, which saves the 11 s install.

- 2026-10-03 (claude): **findings from reading `@tanstack/ai-sandbox-vercel` 0.2.5 and `@vercel/sandbox` 2.9.2** (to confirm against a real sandbox in the new CI lane "Hosted sandbox (Vercel) contracts", `vercel-sandbox.contract.test.ts`):
  - **Probably no patches needed.** `VercelHandle` is a public export. Our provider can call `Sandbox.create` with the full parameters (snapshot source, `networkPolicy`, `persistent`, `tags`, snapshot retention) and wrap the result in the stock handle. Port auth needs only `ports.connect` to return `headers`; the stock OpenCode adapter already forwards channel headers. OpenCode 1.18.34 enforces `OPENCODE_SERVER_PASSWORD` as Basic auth (`opencode:<password>`) on every route, including the event stream (checked locally).
  - **Stock `destroy` only stops.** On a persistent sandbox `stop()` saves state; it does not delete. Deleting (conversation removed, 30 days unused) needs `sandbox.delete()` in our cleanup.
  - **Retention can be Vercel's.** `snapshotExpiration` plus `keepLastSnapshots: { count: 1 }` keeps only the latest saved state and expires it, which may cover the 30-day rule without our own job.
  - **Idle stop:** Vercel's `timeout` caps a session from its start, not from the last activity, so the 5-minute idle stop still comes from our cleanup (last heartbeat). The Vercel timeout is only a backstop.
  - **No custom image needed.** The Workspace base snapshot can carry OpenCode, so hosted sandboxes start from `node24` plus the base, not a registry image.
  - **Option to raise with the user:** the firewall can add request headers per domain (`transform.headers`). The GitHub read token could then live in the firewall rule instead of inside the sandbox.

- 2026-10-02 (user decisions):
  - **Egress:** use Vercel's firewall allowlist (our backend, GitHub, whatever OpenCode needs), because the sandbox can read its Workspace read token.
  - **Lifecycle:** stop a sandbox after **5 minutes idle**. Keep a conversation's saved state **30 days** after last use. Cap each organization at **50 running sandboxes**.
  - **Non-interactive runs** (MCP `ctx_advisor` turns, Slack agent turns, semantic merge, anything not driven by a person in the UI) stop their sandbox **as soon as the run ends**, so they never hold a slot for the idle period.
  - **Credentials and target:** the Vercel access token is the GitHub Actions secret `VERCEL_ACCESS_TOKEN`; project `ctxpipe` in team `ctxpipe`. Deploy must pass it to the Railway backend and worker.

- 2026-10-02 (claude, ticket 07 docs): public docs now describe the target chat. Before closing:
  - add Vercel to the sub-processor table in `apps/docs/content/docs/(guide)/resources/data-processing.mdx`;
  - re-check `workspaces/chat.mdx` ("Where the agent runs", Create PR / Show PR, no Commit+Push) against what ships.

- 2026-10-01 (user): drop Commit+Push (keep Create PR / Show PR, squash on PR); start on `basic`.

- 2026-10-01 (user): no separate spike (Railway plan).
- 2026-10-01 (user): 100 Railway sandboxes too low; asked about Cloudflare. Comparison given (Cloudflare: pooled 1,500 vCPU / 6 TiB limits, ~7× cheaper memory, wipes files on sleep, Worker-only access, no process kill).
- 2026-10-01 (user): Cloudflare Sandboxes chosen — limits are enough, no new vendor, no Enterprise. Files are not a problem because work is pushed to git. Ticket rewritten for Cloudflare.

## Resolution
