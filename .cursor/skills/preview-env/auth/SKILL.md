---
name: preview-env-auth
description: Session, sign-in/out, 2FA, invitations, wrong-account invites, and org switching (preview-env).
disable-model-invocation: true
---

# preview-env auth

Account and membership surface. Runs after [onboarding](../onboarding/SKILL.md), so account A and the org exist. [Harness](../harness.md) is `PASS`. Flow format: [run-setup](../run-setup.md#flow-format). Accounts B and C use their own browser contexts.

### AUTH-1 Session persists
**Requires** ONB-4 (A has an org).
**Steps**
1. As A, reload the current app URL.

**Expect (UI)** still under `/{orgSlug}`; SideNav shows this org; sign-in is not shown.
**Expect (backend)** the same `sessions` row is still valid (no new session row).
**Budget** 3 s / 10 s, reload to SideNav visible.
**Evidence** `AUTH-1-1.png`; trace of the `get-session` request.

### AUTH-2 Sign out and sign in
**Requires** AUTH-1; Workspace 1 exists (ONB-5) for the landing check.
**Steps**
1. Open sign-out (`/.auth/sign-out` or the account control).
2. Sign in at `/.auth/sign-in` with A's email and password.

**Expect (UI)** signed out shows the sign-in form; after sign-in the browser lands on `/{orgSlug}/ws/{workspace1Slug}` (last-used Workspace, new composer). With zero Workspaces it lands on `/{orgSlug}/workspaces/new`.
**Expect (backend)** the old `sessions` row is gone; a new one exists for A.
**Budget** 3 s / 10 s, submit to composer visible.
**Evidence** `AUTH-2-1.png` (sign-in), `AUTH-2-2.png` (composer); trace of the sign-in request.

### AUTH-3 Account chrome and device page
**Requires** AUTH-1.
**Steps**
1. Open `{BASE_URL}/.auth/account`; the Settings index (heading **user account**) renders.
2. Open `{BASE_URL}/.auth/device`; do not submit a code.

**Expect (UI)** account chrome, not an auth error; on the device page the heading **Authorize ctxpipe CLI** and a **Device code** field (placeholder `ABCD-1234`).
**Expect (backend)** none (read only).
**Budget** 3 s / 10 s per page.
**Evidence** `AUTH-3-1.png`, `AUTH-3-2.png`.

### AUTH-4 Two-factor (TOTP) enroll and challenge
**Requires** account B signed in (AUTH-5 done) so A's session stays free of a 2FA challenge; a TOTP generator the run can drive (read the secret from the enrollment screen).
**Steps**
1. As B, open account **Security** (`/.auth/account/security`, *uncertain path*) and enable two-factor with the password.
2. Add the secret to the generator, submit the 6-digit code, save the backup codes.
3. Sign out, sign in as B, and submit a fresh code at the challenge.

**Expect (UI)** enrollment shows **TOTP**; the second sign-in asks for a code and lands in the app after a valid one; an invalid code shows an error and stays on the challenge.
**Expect (backend)** a two-factor row for B; `users` two-factor flag true.
**Budget** 5 s / 15 s per step.
**Evidence** `AUTH-4-1.png` (enrolled), `AUTH-4-2.png` (challenge); trace of the verify request. The secret stays out of the report.

### AUTH-5 Invite a second account and accept
**Requires** ONB-2; account B unregistered; a way to read the invitation link (*uncertain:* when SMTP is not configured the mail is only logged; read the `invitations` row id from the database or the backend log, then open `/.auth/accept-invitation?invitationId={id}&email={B}`, else `SKIP(needs-inbox)`).
**Steps**
1. As A, open `/{orgSlug}/organization/members` and invite B (role member).
2. In B's context, open the invitation link; sign up as B (the email is prefilled).
3. Walk B's joiner slides (welcome, overview, MCP, done) and finish.

**Expect (UI)** A's Members list shows B as pending, then as a member; B passes no create-org step and lands on the org's Workspace composer (`/{orgSlug}/ws/{workspace1Slug}`) with Workspace 1 in the sidebar.
**Expect (backend)** `invitations` row (pending, then accepted); `members` row for B with role member; B's `onboardingCompletedAt` set.
**Budget** 5 s / 15 s, accepting the invite to org visible.
**Evidence** `AUTH-5-1.png` (pending invite), `AUTH-5-2.png` (B in the org); traces of the invite and accept requests.

### AUTH-6 Wrong-account invite (#320)
**Requires** AUTH-5 done (B signed in, in its own context); the invitation-link source from AUTH-5.
**Steps**
1. As A, invite C's address (role member).
2. In B's signed-in context, open the invitation link addressed to C.

**Expect (UI)** a notice **Signed in with a different account** naming both addresses, with a way to sign out or switch; nothing is accepted automatically.
**Expect (backend)** no new `members` row for B in the invited org; the invitation stays pending.
**Budget** 3 s / 10 s, link open to notice.
**Evidence** `AUTH-6-1.png`; trace of the accept-invitation request.

### AUTH-7 Switch organization
**Requires** AUTH-1.
**Steps**
1. As A, open the sidebar **Organization switcher** and create a second org (`pe-{YYYYMMDDHHMMSS}b`).
2. Switch back to the first org from the switcher.

**Expect (UI)** the URL slug changes with the org; the sidebar Workspaces list swaps (the second org has none: a visit to `/` goes to `/{org2}/workspaces/new`); no Workspace of org 1 is visible in org 2.
**Expect (backend)** `organizations` and `members` rows for org 2; A's active organization updates on each switch.
**Budget** 3 s / 10 s per switch.
**Evidence** `AUTH-7-1.png`, `AUTH-7-2.png`; trace of the set-active request.

## Status

- **PASS** AUTH-1, AUTH-2, AUTH-3, AUTH-5, AUTH-6, AUTH-7 `PASS`; AUTH-4 `PASS` or `SKIP`.
- **SKIP** social buttons and reset-password mail (no mailer or provider fixtures).
- **FAIL** bounced to sign-in on reload, a second sign-in not restoring the org, an invite accepted by the wrong account, or a cross-org Workspace visible.
