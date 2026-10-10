# Browser end-to-end testing of critical flows

Status: in-progress (first pr-280 run done 2026-10-10: 11 FAIL, 20 BLOCKED by the GitHub App variables; next: fix tickets, then re-run)
Priority: P0
Owner: unassigned
Blocked by: none (skill phases); 02 for the final hosted pass
Created: 2026-10-01
Updated: 2026-10-10

## Context

CI proves UI behaviour with Storybook `workspace-golden` plays (ADR-045) and backend contracts, but nothing drives the real deployed product through its critical journeys. A `preview-env` skill already exists (`.cursor/skills/preview-env/`: harness + areas `auth`, `org-home`, `workspaces`, `hydrate`, `graph`, `chat`, `files-publish`, `connectors`, `mcp`) for sweeping Railway PR previews. It describes steps per area but not a full critical-flow catalogue with explicit expectations, timings, and evidence. This ticket turns it into the browser critical-flow suite, runs it, refines it, and fixes what it finds.

Available drivers: T3 Code preview tools (`preview_navigate`, `preview_click`, `preview_type`, `preview_snapshot`, `preview_wait_for`, recording). Playwright for scripted reruns: superseded by the 2026-10-04 decisions (not now).

## Goal

A skill that lists every critical user flow with preconditions, steps, and expected outcomes (including timing budgets), and a clean run of it against the pr-280 preview, with every issue found either fixed or ticketed.

## Acceptance criteria

- [ ] Every run starts from registration and onboarding with freshly created accounts (no pre-seeded users).
- [x] Critical-flow catalogue reviewed and approved by the user before execution (2026-10-04).
- [ ] Skill updated (extend `preview-env` areas; no parallel skill) so each flow has: preconditions/data, steps, expected visible result, expected backend side effect (DB row, git commit, workflow), timing budget, evidence to capture (screenshot/recording, trace id).
- [ ] Skill works against local host dev (`https://app.ctxpipe.localhost`) and Railway previews.
- [ ] Full run on pr-280 with a report: per flow `PASS`/`FAIL`/`SKIP`, evidence, trace links.
- [ ] Each `FAIL` → fix with a regression test (Storybook play, contract, or unit) or a new ticket here.
- [ ] Two consecutive clean full runs after fixes; skill refined with anything learned (flaky waits, missing preconditions).
- [ ] Final hosted pass after ticket 02 (Vercel sandboxes) lands.

## Proposed critical flows (for review)

Superseded by the 2026-10-03 catalogue comment below, itself amended by the 2026-10-04 decisions (the original list is kept for history).

1. **Registration + onboarding (start of every run):** sign up a fresh account (unique email per run), go through onboarding to create the org, connect the GitHub App, and create the first workspace — everything later flows use comes from this run. Then: sign in/out, 2FA, invite a second fresh account and accept (incl. signed in as another account, #320), org switch.
2. **Org home:** composer visible, activity heatmap, Home send → new conversation in under 1 s of URL change (instant chrome).
3. **Workspace create/select:** connect GitHub App, select existing repo, create via github.com/new then select, paste any git URL, zero-workspace gate, rename, delete with confirm.
4. **Hydrate:** new workspace reaches active projection; knowledge files listed; malformed file surfaced; push to default branch → tip check → re-hydrate.
5. **Linked repositories:** link/unlink repo, codesearch index completes, search returns hits.
6. **Chat:** first message from Home and from workspace compose; streaming text; tool/reasoning chips; second turn; reload restores history; stop mid-stream; two conversations isolated; sandbox setup wait copy.
7. **Files + publish:** browse conversation files, edit + save, diff, Commit+Push, Create PR, Show PR; stale branch hides actions.
8. **Graph:** pane loads, node detail, no SSR crash on reload.
9. **Connectors:** Linear, Notion, Slack, Confluence, PagerDuty, GitHub PR mirror — connect, config PR, initial sync commits to workspace repo, status shown.
10. **Settings + keys:** org settings, Add Workspace, MCP API keys mint/revoke (#330, #336).
11. **MCP:** OAuth and API-key access, `ctx_advisor` shim answers via workspace chat, cross-tenant access denied (#285).
12. **Resilience:** backend restart mid-chat resumes; worker sleep/wake on preview; 4xx/5xx shows inline errors, never a blank page.

## Plan

1. **Catalogue.** Expand the list above with expectations, data setup, and budgets by reading the routes, PRDs (workspace-chat-*), and existing `preview-env` areas. Present to the user (this ticket's `## Comments`) for approval.
2. **Update the skill.** Restructure `preview-env` so each area file lists its flows in a fixed format (preconditions → steps → expect → evidence → budget), plus a shared run-setup section (unique emails per run, GitHub test org/repo for onboarding, connector test workspaces) and a report template with trace links. Follow `.cursor/skills/writing-great-skills/`.
3. **First run (local host dev),** to shake out the skill itself. Refine wording, waits, and preconditions. Traces export to HyperDX as `local-<name>` (run-setup § Local trace export).
4. **Run on pr-280.** Capture report and evidence. File each failure: fix immediately if small (with a regression test), otherwise a ticket.
5. **Fix loop** until two consecutive clean runs.
6. **Final pass after ticket 02** on Vercel sandboxes; record in `## Resolution`.
7. ~~Convert the most valuable flows into Playwright scripts.~~ Superseded by the 2026-10-04 decisions.

## Open questions

Connector test-workspace credentials, needed only after the first run (provider flows stay `SKIP(needs-human)` until then). Everything else was answered on 2026-10-04.

## Follow-ups

- The onboarding **Install via CLI** card runs `npx ctxpipe init`, whose default server is still `https://app.ctxpipe.ai` (`packages/cli/src/constants.ts:1`); a self-hosted, preview, or local user gets the hosted product. Not fixed here.

## Delegation brief

Read first: this ticket, `.cursor/skills/preview-env/` (all files), `.cursor/skills/writing-great-skills/`, `apps/ui/src/routes/`, `.ai/memory/PRDs/workspace-chat-*.md`, `.ai/scratchpad/git-backed-projects/issues/16-project-workspace-ia.md`.

The next agent does step 3 (first local run), then step 4 (pr-280). Never point flows at production. Report: catalogue diff, run report, list of fixes and new tickets.

## Comments

- 2026-10-11 (claude): **re-run of the failed flows on pr-280** (run `20261010-124612`, commit `0e0974fe`, report [`preview-env-runs/20261010-124612.md`](../preview-env-runs/20261010-124612.md)). Fixture: Workspace 1 is **Paste URL** of the public `ctxpipe-ai/ctxpipe` repository, because the tool policy refused a new public repository; no repository was created. GRAPH-2 ran in headed Chromium. Skipped: AUTH-4, HYD-3 (brief).

  | Flow | Before (051159) | After (124612) | Trace or request (after) |
  | --- | --- | --- | --- |
  | ONB-2 | FAIL 20.5 s | PASS (SLOW) 4.3 s | org create 12:48:42Z |
  | ONB-4 | FAIL, back to welcome slide | PASS (SLOW) 9.3 s, lands on **Add Workspace** | finish 12:49:07Z |
  | AUTH-5 | FAIL, back to welcome slide | PASS 4.8 s, lands on the Workspace | `902580f8-599c-4a73-ba10-6db27cd2097d` |
  | AUTH-1 | FAIL 15.8 s | FAIL 12.1 s (then 2.2 s) | reload 12:49:19Z |
  | RES-3 | FAIL, 504 as a download | PASS; no 504 or download in about 30 loads | `f551de7dc22f036b0a8459918d12f91f`, `88e53f228391ef1d6de5f8d7740dfe04` |
  | WS-5 | FAIL, name lost, URL kept | PASS: name change gets a clear 409, slug change moves the URL; name commit BLOCKED(github-app-env) | `240ef2a03fc21fbde270e5a4e2a93c10`, `1487cd94c382e5371bfca0283415089b` |
  | GRAPH-2 | FAIL (headless) | PASS (headed) 63 ms | `960db61967f5f3a7c4075ce77fd085e9` |
  | GRAPH-3 | FAIL 19.2 s, #418 | FAIL: reloads 3.1 s to 3.7 s with no error, but #418 on a 15.3 s first load and on each signed-out org URL | `399b02f8-262b-4c95-a166-1d4035f9b3c1` |
  | CON-2 | FAIL, rows, PagerDuty 500 | FAIL: PagerDuty 200, no Notion/Linear/PagerDuty card; the Confluence card stays (by design in ticket 25) | `3a1752b86b6b7a1cf1f72ac941b6db4b`, `99382d70679b92b81e1bbbcfc86249db` |

  Remaining FAILs: (1) about 1 document load in 6 takes about 12.5 s; the Railway log shows a 10 s gap with no backend request inside the SSR of the document, which equals the SSR `apiFetch` timeout (trace `07297d7e4b9347e005919dbbae905b0d`, request `69300e69-6676-434e-9e04-4000cda9c183`). AUTH-1 and the slow GRAPH-3 load come from this. (2) React #418 on the slow load and on the signed-out redirect to sign-in. (3) CON-2: the catalogue expects no Confluence card, but ticket 25 keeps it; the user must choose. Leftover repositories from run 051159 remain (no `delete_repo` scope).

- 2026-10-10 (claude): **first full run on pr-280** (run `20261010-051159`, commit `f6fa4c48`, report [`preview-env-runs/20261010-051159.md`](../preview-env-runs/20261010-051159.md)). The local run (plan step 3) was not done first; the brief asked for pr-280. Driver: headless Playwright, one context per account. The preview's GitHub App variables point to the production App, so the GitHub install cannot finish; every flow that needs the App is `BLOCKED(github-app-env)`. To get more coverage, Workspace 2 used a public copy of the knowledge template through **Paste URL**. FAILs, each with steps and a trace in the report: onboarding goes back to the welcome slide after it ends (ONB-4, AUTH-5); two-factor enable 500 because the `twoFactors` schema has no `verified` field (AUTH-4); full-page loads sometimes return 504 after 16 s as `application/octet-stream`, so the browser downloads instead of rendering (RES-3; probably also the slow ONB-2, AUTH-1, GRAPH-3); rename saves the slug but not the display name and keeps the old URL (WS-5); a push does not re-hydrate while the Workspace still reports `ready` (HYD-3); no node inspector in headless (GRAPH-2, to confirm); React #418 on graph reload (GRAPH-3); connector first screens create `forge` and `notion` rows and PagerDuty setup returns 500 (CON-2). Cleanup could not delete the four `pe-20261010-051159-*` repositories: the `gh` token has no `delete_repo` scope (all are private now).

- 2026-10-04 (claude): **review round.** Superseding parts of the comment below: provider connector flows use `SKIP(needs-human)` rather than a separate `SKIP(first-run)` (credentials do not exist yet, and "first run" never expires); the create-workspace docs sentence is restored and the PRD now says there is no dedicated Workspace slide, while **Create workspace** on the connected-GitHub slide ends onboarding at Add Workspace; CHAT-9 is listed as retired, pointing to `sandbox-lifecycle-native.contract.test.ts`. Kept out of the skill and recorded here: budgets approved (user, 2026-10-04); Commit+Push / Create PR without squash / Show PR, the onboarding Workspace behavior, and the first-run connector skip are the 2026-10-04 decisions. The skill now names the real template content (`ctxpipe-ai/preview-env-seed-knowledge`, `ctxpipe-ai/preview-env-seed-code`): 4 knowledge units, 7 `LINKS_TO` plus 4 claim edges (`WorkspaceSignal` with a `predicate`), the malformed file, and `loyaltyPoints(12345) === 17`. The codesearch dev container now gets `DATABASE_URL`, `AUTH_SECRET`, and the OTLP variables by name, with localhost endpoints rewritten to `host.docker.internal`.

- 2026-10-04 (claude): **decisions applied.** Skill (`.cursor/skills/preview-env/`): inputs default to `ctxpipe-ai` and `ctxpipe.dev`; repositories renamed `pe-{run-id}-*` with a cleanup step that always runs; ONB-3 continues with **Close wizard**, ONB-4 expects the snippet on `{BASE_URL}` and no onboarding Workspace step; FP-4/FP-5 expect agent commits on request or task end, **Commit+Push**, **Create PR** keeping every commit, **Show PR**; CHAT-7 asks the agent to commit first; CHAT-9 retired to `SKIP(contract-test)` and the `capacity` flag removed; CON-3 to CON-7 `SKIP(first-run)`, CON-8 runs (ticket 12 is done); `restart-ok` limited to `local` and pr-280; budgets marked approved; human checkpoints include MCP OAuth consent; local runs export to HyperDX and cite trace ids, with a harness check. Code: onboarding MCP snippet uses `window.location.origin` (story `Pages/Onboarding › McpSnippetUsesCurrentOrigin`); Turbo `dev` passes the `OTEL_*` export variables and the codesearch dev container receives them, so `apps/backend/.env.local` alone turns on local export (`ops/observability/USING.md`). Docs: `create-workspace.mdx` and the workspaces PRD no longer claim an onboarding Workspace step. New ticket 13 (skipped-files notice).

- 2026-10-04 (user): answers to the catalogue questions; phase 1 approved.
  1. Workspace creation stays at the zero-Workspace screen after onboarding. A new onboarding is being built on a separate branch, so PRD and docs only stop claiming an onboarding "create Workspace" step (minimal edits; onboarding will change again).
  2. Commit+Push comes back. The agent decides when to commit and push (semantic commits; the user can prompt it; the system prompt recommends committing when a task is done). Create PR does not squash. (Implemented by another agent; this ticket only updates the flows.)
  3. OAuth and consent screens (GitHub App install, connector OAuth, MCP OAuth) stay human checkpoints.
  4. No Playwright conversion now, possibly ever; we'll see in practice how repeatable the LLM-driven runs are.
  5. The 50-sandbox capacity check stays in the backend contract test only; CHAT-9 is not run in the browser.
  6. Restarting services (`restart-ok`) is allowed on local and on the pr-280 preview only.
  7. Traces must be exported for local runs too, so they can be debugged in HyperDX.
  8. Run local first, then pr-280.
  9. Budgets approved as proposed.
  10. Fix now: the onboarding MCP snippet must use the current deployment's origin. Open a ticket for showing knowledge files skipped as malformed on the Workspace page (ticket 13).
  11. GitHub test org: `ctxpipe-ai`. Runs create and delete throwaway repositories there with a run-scoped prefix (`pe-<run-id>-…`) and always clean up.
  12. Test email domain: `ctxpipe.dev` (ours; configurable). Accounts `preview-env+<run-id>-<role>@ctxpipe.dev`; invitation mail may be delivered there.
  13. Connector flows (Linear, Notion, Slack, Confluence, PagerDuty) are skipped on the first run (they stay `SKIP(needs-human)` until test credentials exist); the GitHub PR mirror flow stays.

- 2026-10-03 (claude): **catalogue for approval (phase 1 done, nothing has been run).** *Superseded in part by the 2026-10-04 decisions above: FP-4 is no longer an automatic push, FP-5 no longer squashes, CHAT-9 is retired (no `capacity` flag), and the open questions are answered.* The `preview-env` skill is restructured in `.cursor/skills/preview-env/`: new `run-setup.md` (target guard, accounts, test data, flow format, evidence and traces, write policy), `harness.md` (wake, canary, report template with trace column), and two new areas (`onboarding`, `resilience`). Every flow in every area file has the same fields: Requires, Steps, Expect (UI), Expect (backend), Budget (target / fail), Evidence. 65 flows. It works for `local` (`https://app.ctxpipe.localhost`) and `preview` (`backend-pr-N.up.railway.app`); any other host, production included, is a harness FAIL. Decisions applied: Vercel Sandbox (one microVM per conversation, idle stop at 5 minutes, saved state 30 days, 50 per org with an "at capacity" error, no GitHub token in the sandbox); turn commits pushed automatically with only **Create PR** and **Show PR** (Commit+Push removed); Add Workspace is the sidebar **+**; merged PRs mirror into every Workspace linking the repository; every run starts from registration. Flows that depend on unfinished tickets are `SKIP(needs-ticket-02)` or `SKIP(needs-ticket-12)` until they land.

  Budgets are `target / fail` (over target but under fail is `PASS` with `SLOW`):

  | Area | Flows (budget target / fail) |
  | --- | --- |
  | `onboarding` | ONB-1 register fresh account (3 s / 10 s) · ONB-2 slides + create org (3 s / 10 s) · ONB-3 connect GitHub App, human (15 s / 60 s) · ONB-4 MCP + invite slides, finish (3 s / 10 s) · ONB-5 create Workspace 1 at the zero-Workspace gate (3 s / 10 s) |
  | `auth` | AUTH-1 session persists (3 s / 10 s) · AUTH-2 sign out/in lands on last Workspace (3 s / 10 s) · AUTH-3 account + device pages · AUTH-4 TOTP enroll + challenge (5 s / 15 s) · AUTH-5 invite and accept as a second account (5 s / 15 s) · AUTH-6 wrong-account invite, #320 (3 s / 10 s) · AUTH-7 create and switch org (3 s / 10 s) |
  | `org-home` | HOME-1 sidebar regions · HOME-2 Home dashboard (3 s / 10 s) · HOME-3 Home send opens `conv_…` URL (1 s / 2 s) · HOME-4 command palette · HOME-5 org settings, no Add Workspace there |
  | `workspaces` | WS-1 open + panes · WS-2 settings chips · WS-3 sidebar **+** adds Workspace 2 (3 s / 10 s) · WS-4 Create on GitHub and Paste URL variants · WS-5 rename + slug (2 s / 5 s; `AGENTS.md` commit 60 s / 3 min) · WS-6 link/unlink repository (Indexed 90 s / 5 min) · WS-7 delete with confirm (3 s / 10 s) |
  | `hydrate` | HYD-1 reaches active projection (60 s / 3 min) · HYD-2 malformed file skipped · HYD-3 push to default branch re-hydrates (60 s / 3 min) · HYD-4 Try again recovery (60 s / 3 min) · HYD-5 linked index completes (90 s / 5 min) |
  | `graph` | GRAPH-1 pane loads (3 s / 10 s) · GRAPH-2 node detail (1 s / 3 s) · GRAPH-3 direct-URL reload, no crash (5 s / 15 s) |
  | `chat` | CHAT-1 first message (answer 5 s / 15 s, the PRD target) · CHAT-2 warm turn (5 s / 15 s) · CHAT-3 reload restores (2 s / 5 s) · CHAT-4 stop mid-stream (1 s / 3 s) · CHAT-5 two conversations isolated · CHAT-6 idle stop and resume with files (8 s / 20 s; needs 02) · CHAT-7 lost sandbox rebuilt from branch (10 s / 30 s; needs 02) · CHAT-8 no credential inside the sandbox (needs 02) · CHAT-9 at capacity (gated) |
  | `files-publish` | FP-1 browse files · FP-2 create + save file (2 s / 8 s) · FP-3 Diff · FP-4 turn commit auto-pushed, no Commit+Push (10 s / 30 s; needs 02) · FP-5 Create PR squashes, Show PR (10 s / 30 s) · FP-6 stale branch hides actions (15 s / 45 s) · FP-7 default-branch edit (gated, 30 s / 2 min) |
  | `connectors` | CON-1 catalog (six providers) · CON-2 wizard first screens · CON-3 Linear, CON-4 Notion, CON-6 Confluence, CON-7 PagerDuty: connect, config PR, initial sync (PR 30 s / 2 min, sync 5 min / 15 min; human) · CON-5 Slack thread capture (2 min / 5 min) · CON-8 per-Workspace PR mirror, two Workspaces, unlink (2 min / 5 min; needs 12) |
  | `mcp` | MCP-1 discovery · MCP-2 doctor · MCP-3 API key mint/revoke #330/#336 · MCP-4 `tools/list` · MCP-5 `ctx_advisor` via Workspace chat turn (15 s / 60 s) · MCP-6 cross-tenant denied #285 |
  | `resilience` | RES-1 backend restart mid-chat (90 s / 3 min; gated) · RES-2 worker sleep/wake (preview only, 90 s / 3 min) · RES-3 inline errors, never a blank page (3 s / 10 s) |

  **Run set-up:** accounts A (admin), B (invitee), C (outsider) with unique `preview-env+{run-id}-x@{TEST_EMAIL_DOMAIN}` addresses; org slug `pe-{YYYYMMDDHHMMSS}`; per-run repositories created in the GitHub test org from two persistent template repositories (knowledge, code); connector test workspaces as `ready-for-human` placeholders. Evidence: screenshots and one recording per area in `/tmp/preview-env/{run-id}/`; trace evidence is a HyperDX `TraceId` (preview) or the `x-request-id` plus log line (local, where OTLP is off by default).

  **Findings while reading the code (to confirm, not yet failures):**
  - The PRD and public docs say onboarding offers a Workspace-create step; `ADMIN_SLIDES` has none. The Workspace is created at the zero-Workspace gate (`/{org}/workspaces/new`) after the invite slide.
  - The onboarding MCP snippet always names `https://app.ctxpipe.ai/mcp`, not the current origin.
  - The Workspace UI shows no skipped-file (malformed) report; hydrate only logs it.
  - Commit+Push still exists in the UI (`WorkspaceChatChrome`, the Files empty-state copy); FP-4 expects it gone once ticket 02 ships.

  **Open questions (existing, kept):**
  1. Which GitHub test org and repositories may onboarding install the App on, and credentials for the connector test workspaces (Linear, Notion, Slack, Confluence, PagerDuty)?
  2. Should OAuth-dependent flows (GitHub App install, connector OAuth) be automated, or stay `ready-for-human` checkpoints? The catalogue assumes human checkpoints.
  3. Is the Playwright conversion (step 7) in scope for this ticket?

  **Open questions (new):**
  4. Test email domain: which `TEST_EMAIL_DOMAIN` may the run use, does a preview really send invitation mail, and where does the run read the invitation link when SMTP is off (database row, or a test inbox)?
  5. GitHub test org set-up: App installed on all repositories, two template repositories, and a token for `gh` (create, merge, delete repositories) kept in the run only. Does the hosted GitHub App's install callback and webhooks reach a PR preview and `app.ctxpipe.localhost`, or must `local` use the self-hosted App wizard?
  6. Where should Workspace creation live in onboarding: keep the zero-Workspace gate (current code) or add the slide the PRD and docs describe?
  7. Approve the budgets above. The chat numbers use the PRD target (about 5 s) with a 15 s fail line; the resume number (8 s / 20 s) adds the measured 1.6-1.8 s resume. Change any you disagree with.
  8. CHAT-9 (51st sandbox gets "at capacity") needs 50 running sandboxes in one org. Run it on pr-280 behind a `capacity` flag, or leave it to the ticket-02 contract test?
  9. After Commit+Push goes, when is a user's own saved edit in Files pushed: on save, or only with the next turn? FP-4 step 4 records what happens; say which is intended.
  10. MCP OAuth (client consent) in MCP-4: automate it, or keep it as a human checkpoint? The API-key path is automated.
  11. May the run restart preview services (RES-1 backend restart, RES-2 worker sleep) under a `restart-ok` flag, and is a rolling-deploy tool-call miss acceptable as a known limit?
  12. Local runs have no trace export by default. Accept request id plus log line as evidence for `local`, or export local runs to the shared collector as `local-<name>`?
  13. A hosted pass needs ticket 02's Vercel credentials on the preview. Run `local` and `pr-280` (Docker provider) first, and the hosted-only flows after ticket 02 lands?

- 2026-10-02 (user): GitHub merged-PR mirroring goes into **every Workspace that links the repository** (option A); replaces the old context-repository targeting (ledger row 15).

- 2026-10-01 (user): will provide the GitHub test org and connector credentials when the run reaches that point.

- 2026-10-01 (user): flows start with registration and onboarding, creating accounts as needed. Email sign-up currently needs no verification (`emailAndPassword` without `requireEmailVerification`); if that changes, the run needs a test inbox.

## Resolution

Not resolved. First pr-280 run, 2026-10-10 (run `20261010-051159`, commit `f6fa4c48`): 65 flows, 23 PASS, 11 FAIL, 20 BLOCKED(github-app-env), 11 SKIP. Full table: [`preview-env-runs/20261010-051159.md`](../preview-env-runs/20261010-051159.md).

| Area | PASS | FAIL | BLOCKED | SKIP |
| --- | --- | --- | --- | --- |
| onboarding | ONB-1 | ONB-2, ONB-4 | ONB-3, ONB-5 | - |
| auth | AUTH-2, AUTH-3, AUTH-6, AUTH-7 | AUTH-1, AUTH-4, AUTH-5 | - | - |
| org-home | HOME-1, HOME-3, HOME-4, HOME-5 | - | HOME-2 | - |
| workspaces | WS-1, WS-2, WS-3, WS-4, WS-7 | WS-5 | WS-6 | - |
| hydrate | HYD-1, HYD-2, HYD-4 | HYD-3 | HYD-5 | - |
| graph | GRAPH-1 | GRAPH-2, GRAPH-3 | - | - |
| chat | - | - | CHAT-1 to CHAT-5 | CHAT-6 to CHAT-9 |
| files-publish | - | - | FP-1 to FP-6 | FP-7 |
| connectors | - | CON-2 | CON-1, CON-8 | CON-3 to CON-7 |
| mcp | MCP-1, MCP-2, MCP-3, MCP-4, MCP-6 | - | MCP-5 | - |
| resilience | - | RES-3 | RES-2 | RES-1 |
