---
name: preview-env-auth
description: Sign-in, session persist, account chrome, and device page on a Railway PR preview.
disable-model-invocation: true
---

# preview-env auth

Session surface. [Harness](../harness.md) is already `PASS`. One `computerUse` task.

## 1. Session persists

Reload `{BASE_URL}/{orgSlug}/` (or the post-login URL). Stay signed in; SideNav still shows this org.

**Done when:** after reload, the URL is still under `/{orgSlug}` and sign-in is not shown.

## 2. Account chrome

Open `/{BASE_URL}/.auth/account`. Settings chrome renders (Better Auth account view). Leave 2FA and API keys untouched unless [mcp](../mcp/SKILL.md) later needs a key.

**Done when:** the page title/chrome is the account view, not an auth error.

## 3. Device page

Open `{BASE_URL}/.auth/device`. Heading **Authorize ctxpipe CLI** and a **Device code** field (placeholder `ABCD-1234`) are visible. Do not submit a code.

**Done when:** that heading and field are on screen.

## 4. Sign out and in

Open sign-out (account or `/.auth/sign-out`), then sign in again with the same email/password.

**Done when:** URL is again under `{BASE_URL}/{orgSlug}` (or onboarding/setup with a session).

## Status

- **PASS** — steps 1–4 each met their criterion.
- **SKIP** social buttons, invite email, reset-password mail (PR callback / mailer fixtures).
- **FAIL** — bounced to sign-in on reload, account/device failed to render, or second sign-in did not restore the org.
