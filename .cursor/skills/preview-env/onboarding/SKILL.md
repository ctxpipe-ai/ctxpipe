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
- The browser reaches `/onboarding` (a user with no org is redirected there from `/`) and the first slide, **How ctx| works**, shows **Next**.
- *Uncertain:* the sign-up form may route to `/.auth/email-verification` ("check your email") although no verification is required. If so, sign in with the same credentials and record the screen as an observation, not a FAIL.

**Expect (backend)** `users` row for A with `onboardingCompletedAt` empty; a credential row in `accounts`; a `sessions` row.
**Budget** 3 s / 10 s, submit to onboarding visible.
**Evidence** `ONB-1-1.png` (form), `ONB-1-2.png` (How ctx| works slide); trace of the sign-up request.

### ONB-2 Create the org and land on Home
**Requires** ONB-1.
**Steps**
1. Click **Next** on **How ctx| works**.
2. On **Create your organization**, first submit a 33-character slug and read the error; then enter name `preview-env {run-id}` and slug `pe-{YYYYMMDDHHMMSS}` and submit (Enter or the create button).
3. Observe where the browser lands.

**Expect (UI)** two slides (How ctx| works, create-org) and no GitHub slide; the 33-character slug shows an inline validation error and creates nothing. After the create, the browser lands on Home (`/{orgSlug}`): the **Get started** guide shows **0 of 6 done** with **Connect GitHub** as the open row, and the **Activity** region below it is empty (**No commits on the default branch yet.**).
**Expect (backend)** `organizations` row with the slug; `members` row for A with the owner role; A's active organization set; `users.onboardingCompletedAt` set for A; `org_onboarding` row for the org.
**Budget** 3 s / 10 s, submit to Home visible.
**Evidence** `ONB-2-1.png` (validation error), `ONB-2-2.png` (Home with the guide); trace of the org-create request and the two onboarding-complete requests.

### ONB-3 Connect the GitHub App from the guide (human checkpoint)
**Requires** ONB-2; `GH_TEST_ORG` with the App installable; a human at the GitHub consent screen (`SKIP(needs-human)` otherwise). A Railway preview uses the preview GitHub App, not the production App. Add the callback URL from the PR comment to the preview App. *Uncertain:* whether the App's install callback and webhooks reach a Railway preview or `app.ctxpipe.localhost`; on `local` the operator may first have to finish the self-hosted App wizard.
**Steps**
1. In the **Get started** guide, click **Connect GitHub**.
2. Human: install the App on `GH_TEST_ORG` with access to **all repositories**, then return.
3. Account A signed up with email, so it has no linked GitHub account. The window goes to `/.github/setup` and shows **Connect your GitHub account to finish setup**. Click **Connect GitHub** and authorize.
4. Open **Home**.

**Expect (UI)** after step 3, the page shows the GitHub destination (`/{orgSlug}/github/setup`), not onboarding. On Home, the guide marks **Connect GitHub** done (**1 of 6 done**) and **Create your first Workspace** is the open row.
**Expect (backend)** a `github` row in `accounts` for A; `connections` row of type `github` (`con_*`) for the org with an installation id; `GET /{orgSlug}/api/v1/github/installation` returns a non-null `installationId`.
**Budget** 15 s / 60 s, popup closed to the GitHub destination.
**Evidence** `ONB-3-1.png` (account link page), `ONB-3-2.png` (guide with GitHub done); trace of the installation request; the webhook delivery trace for the install event.

### ONB-4 Create Workspace 1 from the guide
**Requires** ONB-3 `PASS`; repo `pe-{run-id}-ws`.
**Steps**
1. In the **Get started** guide, click **Create Workspace**.
2. On **Add Workspace**, stay on **Select GitHub**, search `pe-{run-id}-ws`, select it.
3. Click **Create Workspace**.

**Expect (UI)** redirect to `/{orgSlug}/ws/{slug}` (slug defaults to the repository name); the composer is visible; the sidebar lists the Workspace; **Settings** shows **Writable** and a hydrate chip (**Hydrate pending** or **Hydrating**; later flows wait for **Hydrate ready**).
**Expect (backend)** `workspaces` row (`ws_*`, slug unique per org); a `workspace-bootstrap` run; on a writable repo, one setup commit on the default branch adding `.agents/skills/ctxpipe-knowledge/SKILL.md` (the template deliberately has none) and possibly normalizing `AGENTS.md` front matter and its folder map; a `workspace-hydrate` run enqueued.
**Budget** 3 s / 10 s, **Create Workspace** to composer visible. Bootstrap commit and hydrate are timed in [HYD-1](../hydrate/SKILL.md).
**Evidence** `ONB-4-1.png` (composer and sidebar); `gh api` commit list of the repo; trace of the create request and the `openworkflow.run.id` of `workspace-bootstrap`.

## Status

- **PASS** ONB-1 and ONB-2 `PASS`; ONB-3 and ONB-4 `PASS` or `SKIP(needs-human)`.
- **FAIL** any flow failing its Expect. ONB-1 failing blocks the run.
