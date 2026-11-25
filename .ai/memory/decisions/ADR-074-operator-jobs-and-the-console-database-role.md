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
   One policy, for every role, does this: it names no role, so a dump and restore of the database needs no role. Every role but the console keeps every row, so the app role works as before. The table owner (migrate) is not subject to the policy, so RLS is not forced.
3. **A ban uses the admin plugin's fields, not the plugin.** `users.banned`, `ban_reason` and `ban_expires` have the plugin's names. `apps/backend/src/auth/ban.ts` does the plugin's part: a session-create hook refuses a banned user (all sign-in methods, and a device login, make a session) and clears a ban that ended, only when no new ban replaced it. The ban job, in one transaction with the flag:
   - deletes the sessions,
   - disables the personal API keys and the organization API keys that the user made (`org_api_key_creators` records the maker of each new organization key),
   - revokes the OAuth access and refresh tokens, and denies the approved device logins,
   - writes a cutoff time (`user_token_cutoffs`): no row can revoke a JWT access token, so a JWT issued before the ban stays refused after an unban.
   The ban locks the user row, and a session-create after hook ends a session that a sign-in inserted after the ban committed.
   `withAuth.ts` refuses a banned user for each credential on each request, also an organization key of a banned maker. Better Auth's `/oauth2/userinfo` and `/oauth2/introspect` refuse a banned user and an older JWT. A chat WebSocket checks its session, the ban and the membership before each turn, because a socket stays open after a sign-out, a ban or a removal.
4. **Member jobs keep the organization plugin's rules.** An organization always keeps an owner. The removal of a member also disables the organization API keys of that organization that the member made. The delete runs the organization's `beforeDeleteOrganization` purge, then the plugin's own delete.
5. **Self-host gets the role too.** Migrate is the same for every deployment, and an env toggle for it is not allowed. A role with no password cannot sign in with a password, so the role does nothing where no console runs. A migrate role that may not create roles skips the step with a warning.

## Consequences

- No admin route exists in the app. A leaked console credential can only queue `admin.*` jobs and read the views.
- An organization API key made before `org_api_key_creators` has no maker, so a ban or a removal does not disable it. Delete the organization, or let an owner delete the key.
- An unban does not enable the disabled API keys again, and does not bring back revoked OAuth tokens: the user signs in and makes new ones.
- A new `admin.*` workflow is a new right of the console role. Review it as such.
