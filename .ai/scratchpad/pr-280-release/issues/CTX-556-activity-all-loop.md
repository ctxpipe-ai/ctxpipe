# CTX-556: Home activity "All workspaces" stays loading and polls without end

**Status:** fixed on `fix/ctx-556-activity-all-loop` (not pushed).

## Cause

The fault is in the backend, not in the UI query key.

- `GET /:orgSlug/api/v1/activity` gives `status: "pending"` when one workspace in the org is pending. A workspace with no projection row is pending.
- The org read did not start projection runs (CTX-545). Only the workspace read and the tip check start them. A workspace that the user never opened on Home has no projection row, so the org read stayed `pending` without end.
- `activityOptions` polls every 2 s while `status === "pending"`, and `WorkspaceActivity` shows the loading state while the status is pending. Thus the UI showed loading and sent the org read every 2 s.
- The UI query key is stable (`["org-activity", orgSlug, null]`). The empty `?` comes from `query: {}` and is harmless.

## Fix

The org read starts a projection run for each workspace with the `pending` status, as the workspace read does. A run writes a projection row, and then the row goes to `ready` or `failed`. Thus the org read ends its `pending` state, and the poll stops. `listOrgWorkspaceCommitProjections` now also returns the workspace `id` and `orgId`.

## Tests

- `apps/backend/src/routes/v1/workspace-activity-routes.integration.test.ts`: "starts a projection run for each workspace that keeps the org read pending" (real Postgres). It failed before the fix and passes after it. It replaces "does not start a projection run on an org read".
- `workspace-commit-activity-native.contract.test.ts` passes.
- biome and `test:policy` pass. Backend `tsc` shows 8 errors in files that this change does not touch.

## Notes

- HyperDX gave 504 during triage, so no live request rate was read.
- Same on `main`? The org activity route came from CTX-545 on the PR branch; not a security bug.
- Risk: while a run waits in the queue, each 2 s poll starts one more run for each pending workspace. The workspace read has the same behavior for one workspace.
