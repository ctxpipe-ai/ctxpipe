# Vercel Sandbox for hosted chat

Status: in progress
Priority: P0
Owner: claude
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
- **Publish UI** (revised 2026-10-04): the agent commits when a task is done and pushes through a workspace tool when asked or when the work is ready; the UI has Commit+Push, Create PR (keeps the commits, no squash) and Show PR. No automatic per-turn push.
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
- [ ] The agent commits in the sandbox and pushes the session branch through a workspace tool that calls the backend broker; Commit+Push, Create PR (commits kept) and Show PR work from the UI; committed work is pushed before a sandbox is deleted after 30 days (Storybook play + native git contract).
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
8. **Git as durable state + publish UI.** The agent commits and pushes through a broker tool; Commit+Push, Create PR (no squash) and Show PR in the UI; push committed work before the 30-day deletion.
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

- 2026-10-04 (claude): **plan step 8 landed: the agent commits and pushes; Commit+Push, Create PR and Show PR.**
  - **Agent:** it commits with git in the sandbox. Commits on the default branch are refused, so a writable conversation now starts on its session branch: the pre-turn update checks it out. It pushes with the bridged tool `push_conversation_branch` (`conversation-branch-push.ts`). The tool calls the broker; the sandbox only packs objects and never holds a write credential. The agent prompt says to commit when a task is done and to push when the user should see the work on GitHub.
  - **Broker** (`pushConversationSession`):
    - It runs one preflight: edits allowed, GitHub, the sandbox on the current revision.
    - A clean sandbox with no unpushed commits does no network work.
    - It replaces the remote tip only when that tip is the one ctx| pushed last (`conversations.last_pushed_sha`), that is, its own history rebased by option D. Commits someone else pushed are fetched, and ours are rebased onto them.
    - A completed revision-transition marker no longer blocks a push; only an unfinished transition or a real rebase does.
    - Results are typed reasons; the client never gets raw Git text.
  - **UI and routes:**
    - **Commit+Push** (`POST …/push`) commits Files edits and pushes. It shows when the sandbox has uncommitted changes or unpushed commits.
    - **Create PR** pushes unpushed commits from a live sandbox, then opens the PR from the session branch as it is. It works without a live sandbox.
    - Both answer 409 `turn_running` at once while a turn holds the conversation.
  - **Session branch:**
    - A sandbox restored from its branch records the commit the branch really builds on, so option D rebases it onto the current default.
    - After the branch's PR is merged or closed, the next prepare or turn moves to `…/<n+1>` from the current default.
  - **Deletion:** before the sweep deletes a sandbox after 30 days, committed work is pushed (the sandbox is started once if stopped); uncommitted files are not. An idle stop keeps files and pushes nothing.
  - **Proof:**
    - Native contract `conversation-branch-push-native.contract.test.ts`. One case runs a production turn with OpenCode and a scripted model: it commits twice and calls the tool, giving two commits on GitHub; a turn that commits without pushing changes nothing. The other cases cover:
      - Commit+Push and Create PR (commits kept, 409 while a turn runs);
      - option D with the completed marker;
      - commits someone else pushed, including ones the agent fetched itself;
      - the shallow-restore rebase;
      - a fresh branch after merge;
      - the 30-day Docker deletion pushing commits and not drafts.
    - Mutation checks fail the matching cases.
    - The route contracts were updated, and a Storybook play covers the chrome with all three actions.
  - **Open:**
    - Not run against real Vercel.
    - `workspace-chat-native.contract.test.ts` times out on this laptop with or without this change.

- 2026-10-04 (user): the agent decides when to commit and push (semantic commits, a push tool through the broker, or on request); Commit+Push returns next to Create PR and Show PR; Create PR keeps the commits (no squash); no automatic per-turn push. Before a sandbox is deleted after 30 days, committed work is pushed.

- 2026-10-03 (claude): **lifecycle landed** (shared with ticket 03; ADR-048 "Lifecycle and limits" and "Cleanup" updated):
  - Idle stop after 5 minutes and 30-day deletion run in a new OpenWorkflow job, `conversation-sandbox-sweep`. The Workspace tip check was not periodic, so each sweep schedules the next one for when a sandbox is next due. Every sandbox start and every tip check also schedule a sweep. A sweep never stops a sandbox while a turn holds `chat-thread:<conversation>`. The idle clock restarts when a turn ends.
  - Vercel stop uses `stopVercelSandbox`, which saves files and revokes the token; a sandbox that is already gone counts as stopped. Deletion uses `deleteVercelSandbox`.
  - 50 per org: every create or resume of a stopped sandbox counts live rows under the org lock `org-sandbox-slots`. Over the limit it fails with `SandboxCapacityError`: 429 on prepare and MCP, and an "at capacity" `RUN_ERROR` in the stream.
  - MCP `ctx_advisor` turns stop their sandbox when the run ends.
  - Proven against real Docker and Postgres in `sandbox-lifecycle-native.contract.test.ts`. The Vercel stop, resume and delete calls are the ones the existing real-Vercel contracts already cover; this change adds no new Vercel-lane assertion.

- 2026-10-03 (claude): **deploy review fixes.**
  - On Railway without `RAILWAY_ENVIRONMENT_NAME`, hosted chat now fails closed (503) instead of tagging its sandbox `local`, which the PR-close cleanup would miss. Off Railway it still tags `local`. Tags come from `conversationSandboxTags` in the provider.
  - `deleteVercelSandbox` is the one delete path: it deletes the sandbox, then any saved snapshots that remain. The token store is optional; PR-close passes none. The cleanup script lists by tag and calls it. A new Vercel-lane contract (stop a persistent sandbox, delete it, no live snapshots left) proves it against real Vercel on the next CI run.
  - The preview variable scripts share `scripts/preview-service-vars.sh`. Both shell tests run in CI's "CI command regression tests" step. The cleanup job runs on `!cancelled()` and installs only the backend's dependencies.
  - Docs: the data page names the 30-day sandbox-file retention as its one fixed period; chat says pushes go through ctx|.

- 2026-10-03 (claude): **deploy and docs landed** (not yet run in a workflow).
  - **Production:** Terraform sets `SANDBOX_PROVIDER=vercel`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID=ctxpipe` and `VERCEL_PROJECT_ID=ctxpipe` on backend and worker (`shared_backend_env_variables` in `infra/module/ctxpipe/railway.tf`). The token is the new required module variable `vercel_access_token`, fed from `secrets.VERCEL_ACCESS_TOKEN` as `TF_VAR_vercel_access_token` in `deploy.yaml` and `terraform-plan-pr.yaml`. An empty token fails the plan, so production cannot deploy without a sandbox provider.
  - **Previews:** `scripts/preview-sandbox-vars.sh` upserts the same four variables on the preview backend and worker in `pr-deploy.yaml` and `pr-preview-roll-existing.yaml`; an empty secret fails the roll. The token never reaches the log.
  - **PR close:** the new job `cleanup_pr_sandboxes` runs after the Railway environment is deleted. It calls `apps/backend/src/scripts/deletePreviewSandboxes.ts pr-<N>`, which lists sandboxes tagged `ctxpipe=workspace-chat, environment=pr-<N>`, re-checks the tag, deletes each sandbox and its saved snapshots, treats 404 as already deleted, fails on any other API error, and refuses any environment that is not `pr-<number>`. Proven with msw against the real `@vercel/sandbox` client (5 tests).
  - **GitHub tokens:** the token rows (`workspace_sandbox_git_tokens`) live in the preview's Neon branch, which the same PR-close job deletes. Tokens that were never revoked expire at GitHub within an hour; nothing outside the deleted sandbox holds them.
  - **Docs:** Vercel is a sub-processor in `resources/data-processing.mdx`; "Where the agent runs" in `workspaces/chat.mdx` describes the hosted microVM per conversation, saved files (30 days), egress limited to GitHub and ctx|, and the GitHub token kept outside the sandbox.
  - **Needs a human:**
    - make sure `VERCEL_ACCESS_TOKEN` is a repository (or organization) secret, not only a `production` environment secret, because the preview jobs have no environment;
    - the next `main` deploy applies the Terraform change; until then production has no `SANDBOX_PROVIDER`;
    - already-running previews pick the variables up on their next roll.
  - **Not covered:** Workspace base snapshots (ticket 03) are not tagged per sandbox, so the PR-close cleanup does not delete them.

- 2026-10-03 (claude): **progress.** Done and proven in the Vercel lane (7 real-sandbox contracts):
  - `vercel-sandbox-provider.ts`: our `Sandbox.create` over the stock `VercelHandle`, with no patches. It sets persistence with 30-day saved state, the egress allowlist, the agent port behind the OpenCode password, and kill enabled.
  - GitHub read token only in the firewall rule, stored encrypted per sandbox (Vercel redacts header values). Rotated after 10 minutes in the background; the replaced token is revoked after 30 s; revoked on stop and delete. Resume costs: fresh token 0.23 s, aged token 0.24 s (rotation off the critical path), after stop 0.9 s.
  - Chat wiring: `SANDBOX_PROVIDER=vercel` fails closed. Model proxy and per-run tool bridge are at the backend's public origin; the tool bridge is a backend route (`handleBridgeJsonRpc`). Known limit: during a rolling deploy, a tool call can land on the replica that is not running the turn.
  - Providers are now docker | vercel | unsandboxed (sbx and railway removed).

  Next: Workspace base snapshot (OpenCode baked in), lifecycle (idle stop job, 50-per-org cap, non-interactive stop), deploy secrets to Railway plus preview tagging and cleanup, an end-to-end chat on pr-280, docs.

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
