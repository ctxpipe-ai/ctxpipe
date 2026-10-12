# CTX-580: "All workspaces" activity lists failed Workspaces

**Status:** fixed on `fix/ctx-580-org-activity-failed` (not pushed).

## Evidence (HyperDX, pr-280)

- The org activity route and the commit projection spans show no errors.
- GitHub repository-scoped token requests got a 422 answer about 330 times
  in the window, against about 65 successful requests. GitHub answers 422
  when the repository is gone or the installation cannot access it. The
  projection marked such a Workspace `failed`, so the note named it.

## Causes

1. A Workspace with a repository that is gone or not accessible got a
   `failed` projection. Each read then started a new run, and the org read
   listed it in `failedWorkspaces`.
2. The deleted Workspace: the backend deletes the row, and the projection
   rows cascade, so the server never returns it (a test on the old code
   passes). Home kept the cached org activity fresh for one minute, so the
   UI showed the old response with the deleted Workspace.

## Fix

- `fetchGithubWorkspaceCommits` returns `reason: "unreachable"` on 404 or
  422. `projectWorkspaceCommits` then records a ready projection with no
  commits for that SHA and logs the skip once (evlog `info`). Other
  failures log a `warn` and stay `failed`.
- The org activity response no longer has `failedWorkspaces`. The Home note
  is gone, with its story.
- The Workspace delete in the UI calls `forgetDeletedWorkspace`, which also
  removes every cached org activity query of the org.

## Tests

- Contract: `workspace-commit-activity-native.contract.test.ts`, two new
  cases (commit list 404, token 422). They failed on the old code.
- Integration: `workspace-activity-routes.integration.test.ts`: no
  `failedWorkspaces` (failed on the old code); a deleted Workspace is
  absent (passes on the old code too; it guards the server side).
- UI: `queries.test.ts`, `forgetDeletedWorkspace` case.
