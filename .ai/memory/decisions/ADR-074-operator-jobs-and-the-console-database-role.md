# ADR-074: Operator jobs run in the worker; the console role only enqueues them

**Status:** Proposed | **Date:** 2026-11-25 | **Tags:** auth, security, database, openworkflow

## Context

The operators of hosted ctxpipe need to ban a user, end the sessions of a user, change or remove a member, and delete an organization. A separate operator console does this ([CTX-1620](https://linear.app/ctxpipe/issue/CTX-1620)). Better Auth's admin plugin has these actions, but it adds admin routes to the production app, and a user with an admin role could call them. The console must not get the rights of the app role either: the app role can read and change every table.

## Decision

1. **The worker does the change.** Each action is an OpenWorkflow workflow named `admin.*` (`apps/backend/src/openworkflow/workflows/admin.ts`): `admin.ban-user`, `admin.unban-user`, `admin.revoke-sessions`, `admin.remove-member`, `admin.set-member-role`, `admin.delete-organization`. The input names the request (`requestId`, also the idempotency key), who asked (`requestedBy`) and who approved (`approvedBy`). The body checks the input with its schema, because the worker does not check the input of a run that another client enqueued. The output and the logs hold ids only.
2. **The console role only enqueues.** Migrate makes the role `ctxpipe_console` (LOGIN, no password, `rds_iam` where that role exists), after the OpenWorkflow migrations (`apps/backend/src/db/provision-console-role.ts`). It gets:
   - INSERT and SELECT on `openworkflow.workflow_runs`, limited by row-level security to rows with `workflow_name LIKE 'admin.%'`, and on INSERT to a new run (`pending`, no attempt, no worker, no parent). No UPDATE, no DELETE, no other OpenWorkflow table: OpenWorkflow's enqueue needs only an advisory lock, a SELECT by idempotency key and `INSERT ... RETURNING *`.
   - The views of `console_read` (`users`, `organizations`, `members`, `invitations`, `sessions`), with no secret column. A view reads with the rights of its owner, so the role has no right on the tables.
   - The schema `console` for its own state, owned by it. The app role has no right on it.
   The app role keeps every row of `workflow_runs` through its own permissive policy. The table owner (migrate) is not subject to the policies, so RLS is not forced.
3. **A ban uses the admin plugin's fields, not the plugin.** `users.banned`, `ban_reason` and `ban_expires` have the plugin's names. `apps/backend/src/auth/ban.ts` does the plugin's part: a session-create hook refuses a banned user (all sign-in methods, and a device login, make a session) and clears a ban that ended. The ban job also deletes the sessions, disables the personal API keys, revokes the OAuth access and refresh tokens and denies the approved device logins, in one transaction. `withAuth.ts` refuses a banned user for each credential on each request, which also stops a JWT access token.
4. **Member jobs keep the organization plugin's rules.** An organization always keeps an owner. The delete runs the organization's `beforeDeleteOrganization` purge, then the plugin's own delete.

## Consequences

- No admin route exists in the app. A leaked console credential can only queue `admin.*` jobs and read the views.
- An organization API key belongs to the organization, so a ban does not stop it. Remove the member or delete the organization to stop it.
- An unban does not enable the disabled personal API keys again, and does not bring back revoked OAuth tokens: the user signs in and makes new ones.
- A new `admin.*` workflow is a new right of the console role. Review it as such.
