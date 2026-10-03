---
name: preview-env-onboarding
description: Registration, onboarding, org creation, GitHub App, and first Workspace on a fresh account (preview-env).
disable-model-invocation: true
---

# preview-env onboarding

First area of every run. Creates account A, the org, the GitHub connection, and Workspace 1; every later area reads them from the [run state](../run-setup.md#run-state). [Harness](../harness.md) is `PASS`. Flow format: [run-setup](../run-setup.md#flow-format).

### ONB-1 Register a fresh account
**Requires** account A credentials from run-setup; sign-up page open (harness step 3).
**Steps**
1. On `{BASE_URL}/.auth/sign-up`, submit account A's email and password (and a name if the form asks).
2. Observe where the browser lands.

**Expect (UI)**
- The browser reaches `/onboarding` (a user with no org is redirected there from `/`) and the welcome slide shows **Get started**.
- *Uncertain:* the sign-up form may route to `/.auth/email-verification` ("check your email") although no verification is required. If so, sign in with the same credentials and record the screen as an observation, not a FAIL.

**Expect (backend)** `users` row for A with `onboardingCompletedAt` empty; a credential row in `accounts`; a `sessions` row.
**Budget** 3 s / 10 s, submit to onboarding visible.
**Evidence** `ONB-1-1.png` (form), `ONB-1-2.png` (welcome slide); trace of the sign-up request.

### ONB-2 Walk the onboarding slides and create the org
**Requires** ONB-1.
**Steps**
1. **Get started**, then **Next** on the overview slide.
2. On **Create your organisation**, first submit a 33-character slug and read the error; then enter name `preview-env {run-id}` and slug `pe-{YYYYMMDDHHMMSS}` and submit (Enter or the create button).
3. Confirm the next slide is **Connect GitHub**.

**Expect (UI)** slides in order (welcome, overview, create-org, github); the 33-character slug shows an inline validation error and creates nothing.
**Expect (backend)** `organizations` row with the slug; `members` row for A with the owner role; A's active organization set.
**Budget** 3 s / 10 s, submit to the GitHub slide.
**Evidence** `ONB-2-1.png` (validation error), `ONB-2-2.png` (GitHub slide); trace of the org-create request.

### ONB-3 Connect the GitHub App (human checkpoint)
**Requires** ONB-2; `GH_TEST_ORG` with the App installable; a human at the GitHub consent screen (`SKIP(needs-human)` otherwise). *Uncertain:* whether the hosted App's install callback and webhooks reach a Railway preview or `app.ctxpipe.localhost`; on `local` the operator may first have to finish the self-hosted App wizard.
**Steps**
1. Click **Connect GitHub**.
2. Human: install the App on `GH_TEST_ORG` with access to **all repositories**, then return.
3. Wait for **Finalising connection...** to clear.

**Expect (UI)** the button reads **Manage GitHub App**; the copy says GitHub is connected.
**Expect (backend)** `connections` row of type `github` (`con_*`) for the org with an installation id; `GET /{orgSlug}/api/v1/github/installation` returns a non-null `installationId`.
**Budget** 15 s / 60 s, popup closed to **Manage GitHub App** (the UI holds "Finalising" for at least 1.8 s).
**Evidence** `ONB-3-1.png`; trace of the installation request; the webhook delivery trace for the install event.

### ONB-4 MCP slide, invite slide, finish
**Requires** ONB-2 (ONB-3 optional; **I'll do this later** skips GitHub).
**Steps**
1. On the MCP slide read the snippet and **Install via CLI**; do not click **Install via PR**. Click **Continue**.
2. On the invite slide choose **I'll do this later**.
3. Wait for the transition into the app.

**Expect (UI)** the MCP snippet URL is recorded (today it always reads `https://app.ctxpipe.ai/mcp?orgSlug={orgSlug}`, which is not the target origin on `local` or `preview`; note it). After finishing, an org with zero Workspaces lands on `/{orgSlug}/workspaces/new` (**Add Workspace**).
**Expect (backend)** `users.onboardingCompletedAt` set for A; `org_onboarding` row for the org.
**Budget** 3 s / 10 s, finish to **Add Workspace** visible (includes a 320 ms fade).
**Evidence** `ONB-4-1.png` (snippet), `ONB-4-2.png` (Add Workspace); trace of the two onboarding-complete requests.
*Uncertain:* the PRD and public docs say onboarding offers a Workspace-create step; the slide list (`ADMIN_SLIDES`) has none, so creation happens at this zero-Workspace gate. Record which is true.

### ONB-5 Create Workspace 1 at the zero-Workspace gate
**Requires** ONB-4 and ONB-3 `PASS`; repo `preview-env-{run-id}-ws`.
**Steps**
1. On **Add Workspace**, stay on **Select GitHub**, search `preview-env-{run-id}-ws`, select it.
2. Click **Create Workspace**.

**Expect (UI)** redirect to `/{orgSlug}/ws/{slug}` (slug defaults to the repository name); the composer is visible; the sidebar lists the Workspace; **Settings** shows **Writable** and a hydrate chip (**Hydrate pending** or **Hydrating**; later flows wait for **Hydrate ready**).
**Expect (backend)** `workspaces` row (`ws_*`, slug unique per org); a `workspace-bootstrap` run; on a writable repo, one setup commit adding any missing `AGENTS.md` and `.agents/skills/ctxpipe-knowledge/SKILL.md` on the default branch (none when the template has them); a `workspace-hydrate` run enqueued.
**Budget** 3 s / 10 s, **Create Workspace** to composer visible. Bootstrap commit and hydrate are timed in [HYD-1](../hydrate/SKILL.md).
**Evidence** `ONB-5-1.png` (composer and sidebar); `gh api` commit list of the repo; trace of the create request and the `openworkflow.run.id` of `workspace-bootstrap`.

## Status

- **PASS** ONB-1, ONB-2, ONB-4 `PASS`; ONB-3 and ONB-5 `PASS` or `SKIP(needs-human)`.
- **FAIL** any flow failing its Expect. ONB-1 failing blocks the run.
