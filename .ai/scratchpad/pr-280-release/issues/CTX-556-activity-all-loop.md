# CTX-556: Home activity "All workspaces" stays loading and polls without end

**Status:** fixed on `fix/ctx-556-activity-all-loop` (not pushed).

## Cause

- `GET /:orgSlug/api/v1/activity` gave `status: "pending"` while one workspace in the org was pending. A workspace with no projection row is pending.
- The org read does not start an unbounded number of projection runs (2e57303d removed that on purpose: each 2 s poll started N runs, and each run started a worker deploy in a preview). Thus a workspace that the user never opened stayed pending, and the org read stayed pending.
- `activityOptions` polled every 2 s while the status was `pending`, and Home showed the loading state.

## Fix

1. Backend: the org read is `ready` when one workspace is ready. An optional `pendingWorkspaces` list (slug, name) names the pending workspaces, as `failedWorkspaces` does. The read is `pending` only when no workspace is ready.
2. Backend: the org read starts at most one projection run per pending workspace in each 5-minute window (idempotency key `org-activity-projection:<workspaceId>:<bucket>`).
3. Backend: `runWorkflowWithWorkerWake` looks for a run with the same idempotency key first. A repeated key returns the earlier run and does not wake the worker again.
4. UI: under All workspaces, Home shows the data at once, with a quiet note that names the pending workspaces. It polls every 10 s while a workspace is pending, and stops after 18 reads (about 3 minutes).

The first approach (start a run for each pending workspace on each read, ec5431c9) was ruled out for the reason in item 2 of the cause.

## Tests

- `apps/backend/src/routes/v1/workspace-activity-routes.integration.test.ts` (real Postgres): ready with `pendingWorkspaces`; pending only when no workspace is ready; 10 polls start one run per pending workspace. Red before, green after.
- `apps/backend/src/openworkflow/client.integration.test.ts`: a repeated idempotency key returns the same run and does not deploy the worker again (msw on the Railway API). Red before (2 deploys), green after.
- `apps/ui/src/features/workspaces/org-activity-poll.test.ts` (msw, fake intervals): one read in 9 s, then one each 10 s, stops after about 3 minutes. Red before (5 reads in 9 s).
- Story `Components/Home/Activity/AllWorkspacesPendingNote` (play test counts org reads: 1 in 3 s). It passed in a local golden run. It is not in the golden list, because the activity stories are not golden.
- biome and `test:policy` pass. `tsc` errors in backend and UI are in files that this change does not touch.

## Notes

- Not on `main`: the org activity route came from CTX-545 on the PR branch. Not a security bug.
- HyperDX gave 504 during triage.
- While a pending workspace has partial commits, the org read also shows them.
