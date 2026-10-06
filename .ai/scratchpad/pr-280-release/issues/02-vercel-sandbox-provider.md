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

- 2026-10-04 (user): Commit+Push comes back now that the sandbox provider changed. The agent decides when to commit and push: semantic commits, the user can prompt it, and the system prompt recommends committing when a task is done. Create PR does not squash. Supersedes the 2026-10-01 "drop Commit+Push, squash on PR" decision and the automatic per-turn push.

- 2026-10-07 (claude): **Workspace base, review round 4:**
  - **Builder start failure:** when the builder cannot start (no hosted access, no agent snapshot, a Vercel 429 or 5xx, a Docker create or start error), the build ends its lease at once (`destroy_failed`). Before, the row stayed `building` and held its slot for up to 1 hour.
  - **Failed start from a base:** the status of the start's error no longer marks the base failed. Only `Snapshot.get` decides: the snapshot is gone or not `created`. A 400, 402 or 409 can be about another option.
  - **Failed builds:** a `destroy_failed` base with no snapshot is the source of no sandbox, so cleanup deletes it at once.
  - **Sweep schedule:** a Vercel base kept for a conversation sandbox waits for that sandbox's expiry, not the 5-minute retry. A time already past becomes the next retry, so the sweep chain does not stop.
  - **Known gap:** the hosted lane calls `startVercelWorkspaceBase` and `bootstrapWorkspace` directly. So `runWorkspaceBaseBuild` (lease and publish) never runs against real Vercel; msw + Postgres tests cover it with a local-process builder.

- 2026-10-06 (claude): **Workspace base, review round 3** (ADR-048 "Fast start" and "Cleanup" updated):
  - **Lease:** the build renews its lease while the clone and setup run, and checks the lease in SQL right before the capture and at the publish. A lost lease stops the build and deletes its builder. The lease predicate is written once, in SQL (`leaseHeld` on each read).
  - **Publish lock:** the publish takes the Workspace lock that a create holds while it chooses its base and records its row. A create that interleaves with a publish keeps the old base (msw + Postgres test).
  - **Temporary Vercel errors:** a 429, 5xx or network error on `Sandbox.create` no longer marks the base failed; that start goes on without a base. Only a 4xx about the source snapshot, or `Snapshot.get` showing it gone or not usable, marks it. A `destroy_failed` base is kept while a sandbox may use it.
  - **One retry layer:** the build step runs once. A failed build marks its row `destroy_failed` in its own catch; the next 10-minute window's first start retries. The `release` step, the step retries and their tests are gone.
  - **Scheduling:** each base schedules the org's next sweep (retention end, lease end, retry), so a dormant hosted org's bases go without a worker restart.
  - **No-token proof:** the lane streams a tar of `.git`, `$HOME`, `/etc` and `/tmp` from the conversation sandbox and searches it in the test process, with the git config and environment. The token never enters the sandbox.
  - **Not changed:** the msw builder test still runs the builder's commands in a local process, because the fake Vercel API cannot run commands. The hosted lane runs the same clone and setup in a real Vercel builder.

- 2026-10-05 (claude): **Workspace base, review round 2** (ADR-048 "Fast start" and "Cleanup" updated):
  - **Retention race fixed:** publish sets the base's `created_at` to the publish time. A conversation that starts from the old base while the next one builds now keeps the old base. Proven with msw + Postgres (`workspace-sandbox-base-vercel.integration.test.ts`).
  - **Org context fixed:** the sweep's base cleanup and the build's reserve step read the Workspace with the explicit org id. Before, both needed a request org context that a workflow does not have, so in production they failed with "Missing org context". The native tests hid this, because they run inside an org context. The integration tests now call both without one.
  - **Failed builds:** OpenWorkflow runs the build at most three times. After the last failure, `release` marks the row `destroy_failed`, so it stops blocking builds and holding a slot at once.
  - **Builder egress:** a base builder reaches GitHub only (token in the firewall rule). It cannot reach our backend.
  - **Bad base:** if `Sandbox.create` fails on a base that Vercel still lists, the base is marked `destroy_failed` and that start goes on from the agent snapshot, once.
  - **Agent snapshot:** no expiry in production, 30 days on previews. Builders of other OpenCode versions are deleted after a build. The last-week replacement, the age windows and the stale-cache fallback are gone.
  - **Simpler build:** capture and publish are one conditional UPDATE. A capture that a crash left unpublished is deleted with its builder, whose id the row holds.
  - **No-token proof:** the lane no longer puts the token into the sandbox. It reads the repository config, the environment and small credential files, and the test process checks the output.
  - **Not measured yet:** a crash during a build leaves the builder's token unrevoked until it expires (one hour at most). A production builder that a crash leaves before its id is recorded has no cleanup path. Whether a base outlives deletion of the agent snapshot it was built from. The token is revoked on every path except a process crash.
  - **Still CI-only:** the Vercel lane. With msw + Postgres, publish, retry and failure of the build step are tested (a local-process builder stands in for the Vercel sandbox), and preview expiry as a unit. The Vercel branch of `workspaceBaseBuilder` runs only in the lane.
  - **Preview chat failure (exit 127):** the PR head starts a conversation without a base from bare `node24` and runs `command -v opencode || npm install -g …` in the session. The session environment replaces `PATH` with `/home/vercel-sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin`. The `node24` image keeps Node and npm under `/vercel/runtimes/node24/bin`, so neither `opencode` nor `npm` was found. Fixed two ways: a conversation always starts from the Workspace base or the agent snapshot and never runs npm, and the session `PATH` keeps `/vercel/runtimes/node24/bin`, so the agent's commands find `node`. Only the agent snapshot's builder installs OpenCode, without the session environment. Not proven on real Vercel yet: local `.env.local` has no Vercel credentials. The lane checks `opencode`, `node` and `npm` with the session `PATH`.

- 2026-10-04 (claude): **Workspace base, third review round** (ADR-048 "Fast start" and "Cleanup" updated):
  - **Sandbox key:** the Vercel key image is now the fixed value `vercel-agent`, so an OpenCode upgrade never orphans hosted conversations; a resumed sandbox keeps its OpenCode. Bases still match the versioned agent image. The change from the earlier key gives hosted conversations a new sandbox once, before launch.
  - **Retention:** the Vercel survival question (does a sandbox outlive its source snapshot) is still not measured: no Vercel credentials outside CI. Until it is, a Vercel base is kept while any Vercel conversation sandbox of its Workspace that could have started from it exists.
  - **Agent snapshot:** cached in the process, rebuilt when no builder is found, so discovery no longer depends on Vercel keeping stopped builders. A failed start forgets the cache entry; a failed lookup uses a cached snapshot that has not expired. Spent builders are deleted after a build, off any start.
  - **Outages:** a base check that fails with anything but 404 starts the conversation without the base and keeps it (msw + Postgres integration test).
  - **Preview bases:** they expire after 30 days, so a PR-close cleanup that misses a builder leaves a bounded leftover.
  - **Builds:** retry-safe. The reserve id comes from the workflow run, publish is folded into the build as one conditional UPDATE, a failed builder is deleted, and the token is revoked on every path except a process crash. Only builds with a held lease count toward the 50.
  - **Still CI-only:** the Vercel lane (survival, stopped builder kept, snapshot deletion, npm blocked, no token in the base).

- 2026-10-04 (claude): **Workspace base reworked after adversarial review** (supersedes the comment below; ADR-048 "Isolation", "Fast start", "Cleanup"):
  - **No conversation sandbox reaches npm.** Per environment and OpenCode version there is an agent snapshot (`vercelAgentSnapshot`). Its builder, tagged `ctxpipe=workspace-agent`, can reach only `registry.npmjs.org`; it installs OpenCode and is snapshotted with a 30-day expiry. It is built on first use and replaced in the background in its last week; spent builders are deleted. Conversations without a base start from it, and Workspace base builders start from it (GitHub only). `extraHosts` is gone from the conversation policy, so token rotation cannot add hosts. `chat.mdx` ("GitHub and ctx| only") stays true.
  - The base is chosen when a sandbox is created, not encoded in the sandbox key. Existing sandboxes resume as they are, and a gone snapshot falls back to the agent snapshot once.
  - Build: three durable steps (reserve / build / publish) with a one-hour row lease. Builders count toward the 50 per org. Stale means a day old and behind (age only).
  - Crash safety: the snapshot id is written to the row as soon as `snapshot()` returns. Base deletion lists snapshots under the builder's name and deletes them before the builder, so a crash before the id was recorded still cleans up.
  - **CI-only measurements (Vercel lane, not yet run):**
    - whether a stopped sandbox resumes with its files after its source snapshot is deleted. Asserted, because the design relies on it;
    - whether deleting a sandbox deletes the snapshots taken from it. Reported only: deletion handles both cases;
    - agent-snapshot build and lookup, base build, and starts from each, with timings.
  - The lane also asserts: `opencode` present from the agent snapshot and from a base; npm unreachable from both; no token in the base's git config, environment or files; base deletion by builder name alone removes the snapshot; the PR-close tag lookup finds the builder.
  - PR-close cleanup also deletes agent builders (all versions), snapshots first (msw test).

- 2026-10-04 (claude): **Workspace base landed** (plan step 5; shared with ticket 03; ADR-048 "Fast start" and "Cleanup" rewritten to match):
  - A base is a `base` row in `workspace_sandbox_instances` (no migration). The worker job `workspace-sandbox-base` builds it, one at a time per Workspace (lock `workspace-base:<ws>`). The Workspace lock is held only to record the builder and to publish.
  - Vercel, no patch: a `node24` builder (tags `ctxpipe=workspace-base, environment=<env>`, GitHub token in its firewall rule, npm registry allowed) clones, installs OpenCode, then `snapshot({ expiration: 0 })`. The stopped builder is kept as the snapshot's owner. Conversations start with `source: snapshot` through `vercelConversationProvider({ baseSnapshotId })`.
  - Found while wiring it: the egress allowlist had no npm registry, so a sandbox that installs OpenCode could not have done so. Only base builders and conversation sandboxes that start before their Workspace has a base now reach `registry.npmjs.org`.
  - New conversations start from the newest base; existing ones keep their sandbox (the base is in the image identity, so it is in the key). With no base, the start goes ahead as before and requests a build; the first turn never waits.
  - Rebuilt when the branch moved and the base is a day old, or more than 50 commits behind (GitHub compare). Deleted when unused by the sweep, the tip check, relink and Workspace deletion. The worker-start backstop also sweeps orgs that have bases.
  - The PR-close cleanup now also deletes `workspace-base` builders with their snapshots (msw test).
  - The Vercel agent identity is now `vercel-node24/opencode-ai@<version>`, so an OpenCode bump gives new bases. It also gives existing hosted conversations a new sandbox once; production has not run hosted chat yet.
  - **CI only, not yet run:** the new Vercel-lane contract `Workspace base` in `vercel-sandbox.contract.test.ts`. It builds a base from `octocat/Hello-World` with OpenCode, checks that the PR-close tag lookup finds the builder and that the snapshot is listed under its name, starts a conversation from it (clone and `opencode --version` present, npm blocked), and deletes the base. It reports these timings: builder create + clone + install (≈ a start without a base), snapshot, start from base, and `opencode` ready. Expect ~12 s without a base vs ~1 s from one (earlier measurements: install 11.3 s, start from snapshot 0.9 s).
  - Open: if Vercel drops a stopped non-persistent builder, the tag lookup would miss the base snapshot on PR close. The contract asserts this.

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
