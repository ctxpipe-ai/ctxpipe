# CTX-527: write-access probe stays "unknown" on GitHub errors

**Status:** fixed on the PR branch. The bug is not on `main` (the Workspace write probe is PR 280 code). It is not a security bug.

## Cause

- `writeStatusFromGithubProbeError` returned `unknown` with no reason for a 5xx, a 429, or a network error. The UI polled the Workspace detail every 2 s while the status was `unknown`, and each read started an org-wide tip check once each minute.
- A 403 primary rate limit ("API rate limit exceeded") went to `read_only` with the `contentsWriteDenied` reason. That reason was incorrect.

## Fix

- The probe now keeps `unknown` with the `WRITE_STATUS_REASONS.checkFailed` reason for an error that does not prove access or no access (5xx, 429, 403 rate limit, network). `nextPersistedWriteProbe` keeps that reason. This is a definite state. No schema change.
- New route `POST /workspaces/{slug}/check-write-access` clears a failed check (only when the status is `unknown`) and starts one tip check for the org each minute.
- UI: the detail poll runs only while the status is `unknown` with no reason. The settings pane shows "Write access not checked" with the reason and a "Check again" button. The chat header badge shows the same label.

## Tests

- `apps/backend/src/openworkflow/workflows/workspace-tip-check.contract.test.ts`: msw GitHub 502, 403 rate limit, 429 secondary limit. Each run ends in `unknown` + `checkFailed`. All three failed before the fix (the 403 case gave `read_only`).
- `apps/backend/src/routes/v1/workspace-http-native.contract.test.ts`: a failed check, then the retry route, then the tip check resolve the state to `writable`.
- `apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx` `WriteCheckFailedStopsPolling` (golden play): no detail read in 4.5 s after the failed state, the retry polls again until `writable`, then the poll stops.

## Open points

- A Workspace that was `writable` still moves to `unknown` (now with a reason) on a GitHub error. That pauses write jobs until the next good probe. This was the old behavior too.
- The GET path still starts an org-wide tip check once each minute on a page load while the status is `unknown`. A probe scoped to one Workspace is a possible follow-up.
