# Browser end-to-end testing of critical flows

Status: plan-review
Priority: P0
Owner: unassigned
Blocked by: none (skill phases); 02 for the final hosted pass
Created: 2026-10-01
Updated: 2026-10-01

## Context

CI proves UI behaviour with Storybook `workspace-golden` plays (ADR-045) and backend contracts, but nothing drives the real deployed product through its critical journeys. A `preview-env` skill already exists (`.cursor/skills/preview-env/`: harness + areas `auth`, `org-home`, `workspaces`, `hydrate`, `graph`, `chat`, `files-publish`, `connectors`, `mcp`) for sweeping Railway PR previews. It describes steps per area but not a full critical-flow catalogue with explicit expectations, timings, and evidence. This ticket turns it into the browser critical-flow suite, runs it, refines it, and fixes what it finds.

Available drivers: T3 Code preview tools (`preview_navigate`, `preview_click`, `preview_type`, `preview_snapshot`, `preview_wait_for`, recording), and Playwright for scripted reruns.

## Goal

A skill that lists every critical user flow with preconditions, steps, and expected outcomes (including timing budgets), and a clean run of it against the pr-280 preview, with every issue found either fixed or ticketed.

## Acceptance criteria

- [ ] Every run starts from registration and onboarding with freshly created accounts (no pre-seeded users).
- [ ] Critical-flow catalogue reviewed and approved by the user before execution.
- [ ] Skill updated (extend `preview-env` areas; no parallel skill) so each flow has: preconditions/data, steps, expected visible result, expected backend side effect (DB row, git commit, workflow), timing budget, evidence to capture (screenshot/recording, trace id).
- [ ] Skill works against local host dev (`https://app.ctxpipe.localhost`) and Railway previews.
- [ ] Full run on pr-280 with a report: per flow `PASS`/`FAIL`/`SKIP`, evidence, trace links.
- [ ] Each `FAIL` → fix with a regression test (Storybook play, contract, or unit) or a new ticket here.
- [ ] Two consecutive clean full runs after fixes; skill refined with anything learned (flaky waits, missing preconditions).
- [ ] Final hosted pass after ticket 02 (Railway sandboxes) lands.

## Proposed critical flows (for review)

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
3. **First run (local host dev),** to shake out the skill itself. Refine wording, waits, and preconditions.
4. **Run on pr-280.** Capture report and evidence. File each failure: fix immediately if small (with a regression test), otherwise a ticket.
5. **Fix loop** until two consecutive clean runs.
6. **Final pass after ticket 02** on Railway sandboxes; record in `## Resolution`.
7. (Optional, ask) Convert the most valuable flows into Playwright scripts for repeatable runs.

## Open questions

- Accounts are created by the run itself (user, 2026-10-01). Still needed: which GitHub test org/repos the onboarding may install the App on, and credentials for connector test workspaces (Linear/Notion/Slack/Confluence/PagerDuty).
- Should OAuth-dependent flows (GitHub App install, connector OAuth) be automated, or stay `ready-for-human` checkpoints in the run?
- Do you want the Playwright conversion (step 7) in scope for this ticket?

## Delegation brief

Read first: this ticket, `.cursor/skills/preview-env/` (all files), `.cursor/skills/writing-great-skills/`, `apps/ui/src/routes/`, `.ai/memory/PRDs/workspace-chat-*.md`, `.ai/scratchpad/git-backed-projects/issues/16-project-workspace-ia.md`.

Phase 1 only until the user approves the catalogue. Never point flows at production. Report: catalogue diff, run report, list of fixes and new tickets.

## Comments

- 2026-10-01 (user): flows start with registration and onboarding, creating accounts as needed. Email sign-up currently needs no verification (`emailAndPassword` without `requireEmailVerification`); if that changes, the run needs a test inbox.

## Resolution
