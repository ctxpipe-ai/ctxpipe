# CTX-556: Home activity "All workspaces" stays loading and polls without end

**Status:** fixed on `fix/ctx-556-activity-all-loop` (not pushed).

## Cause

- `GET /:orgSlug/api/v1/activity` gave `status: "pending"` while one workspace in the org was pending. A workspace with no projection row is pending.
- The org read does not start an unbounded number of projection runs (2e57303d removed that on purpose: each 2 s poll started N runs, and each run started a worker deploy in a preview). Thus a workspace that the user never opened stayed pending, and the org read stayed pending.
- `activityOptions` polled every 2 s while the status was `pending`, and Home showed the loading state.

## Fix

1. Backend: the org read is `ready` when one workspace is ready. An optional `pendingWorkspaces` list (slug, name) names the pending workspaces, as `failedWorkspaces` does. The read is `pending` only when no workspace is ready.
2. Backend: the org read and the workspace read start at most one projection run per workspace state in each 5-minute window. The idempotency key is `activity-projection:<workspaceId>:<desiredSha>:<projection status>:<bucket>`.
3. Backend: `runWorkflowWithWorkerWake` wakes the worker only when the returned run is pending. A repeated key for a running or finished run does not wake it. The 120 s wake debounce limits repeats.
4. UI: when the org read is ready, All workspaces shows the data at once, with a quiet note that names the pending workspaces. While no workspace is ready, it shows only the loading state. The read without a day polls every 10 s while a workspace is pending, for 3 minutes from when the pending list became non-empty. The read of one day does not poll.

The first approach (start a run for each pending workspace on each read, ec5431c9) was ruled out for the reason in item 2 of the cause.

## Tests

- `apps/backend/src/routes/v1/workspace-activity-routes.integration.test.ts` (real Postgres): ready with `pendingWorkspaces`; pending only when no workspace is ready; 10 polls start one run per pending workspace. Red before, green after.
- `apps/backend/src/openworkflow/client.integration.test.ts`: a repeated key for a finished run returns that run and does not deploy the worker again (msw on the Railway API). Red before (2 deploys), green after.
- `apps/ui/src/features/workspaces/org-activity-poll.test.ts` (msw, fake intervals): one read in 9 s, then one each 10 s, stops after about 3 minutes. Red before (5 reads in 9 s).
- `apps/backend/src/routes/v1/workspace-activity-routes.integration.test.ts`: 10 workspace reads start one run. The 10-read tests use a fixed clock in one window.
- `org-activity-poll.test.ts` also covers a workspace that becomes pending after 20 reads, and a day read that does not poll.
- Stories `AllWorkspacesPendingNote` (counts org reads: 1 in 3 s) and `AllWorkspacesNoneReady` (loading only, no empty text). Both passed in a local golden run; `AllWorkspacesNoneReady` failed on the earlier component. They are not in the golden list, because the activity stories are not golden.
- biome and `test:policy` pass. `tsc` errors in backend and UI are in files that this change does not touch.

## Notes

- Not on `main`: the org activity route came from CTX-545 on the PR branch. Not a security bug.
- HyperDX gave 504 during triage.
- While a pending workspace has partial commits, the org read also shows them.
