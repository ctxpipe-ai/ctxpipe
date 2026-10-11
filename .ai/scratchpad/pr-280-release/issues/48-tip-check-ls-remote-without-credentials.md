# workspace-tip-check fails on a private repository: git ls-remote runs without credentials

Status: ready-for-human
Priority: P2
Owner: unassigned
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Ticket 37 listed every error span on `pr-280` during the audit. The tip check of one Workspace fails each time it runs.

## Evidence

- 2026-10-11 between 01:14:50 and 01:30 UTC: five `workflow_run.execute` spans of `workspace-tip-check` (service `openworkflow`) are `Error`, for example trace `36660a889ea954df3cf8b12852c91de1`.
- Status message: `Command failed: git ls-remote --symref -- https://github.com/<team org>/<private repo> HEAD` / `fatal: could not read Username for 'https://github.com': terminal prompt`.
- The repository is a private repository in the team's GitHub org, linked to a Workspace of the test org that ticket 37 did not create.

Likely cause: `apps/backend/src/services/git/clone-tree.ts` (the `--symref` call) runs `ls-remote` on the plain HTTPS URL, without the GitHub App installation token, from `apps/backend/src/openworkflow/workflows/workspace-tip-check.ts`. A public repository passes; a private one fails.

## Expected vs actual

- Expected: the tip check reads the default branch of a private repository with the installation token, or ends with a clear "no access" state that the UI shows.
- Actual: a failed run each time, with a credential prompt error.

## Scope

- Pass the installation token (as other git calls in `services/git/` do) to the `ls-remote` call, and set `GIT_TERMINAL_PROMPT=0`.
- Test against a local git remote that needs credentials (see `apps/backend/src/test/native-git-remote.ts`).

## Acceptance criteria

- [ ] A tip check for a private repository with access succeeds on a preview.

## Comments

## Resolution

The token path was already correct: `resolveGitRemoteTip` sends the installation token in an `http.<remote>.extraHeader` set through `GIT_CONFIG_*` environment variables (not argv, not the URL), and it sets `GIT_TERMINAL_PROMPT=0`. The token is `undefined` only when the Workspace (or the linked repository) has no GitHub connection. That policy is deliberate: a read credential comes only from the remote's explicit connection. So the failed run is a true "no access" case, and the fix ends it cleanly:

- `services/git/clone-tree.ts`: an `ls-remote` that fails on credentials (no username, authentication failed, repository not found, HTTP 401/403/404) now throws `GitRemoteAccessError` with a fixed, token-free message ("ctx| has no access to this repository. Add the repository to the GitHub App installation, then refresh."). It does not carry the Git stderr. `GIT_ASKPASS` is now empty, so a host askpass program cannot prompt.
- `workflows/workspace-tip-check.ts`: the tip check skips a Workspace or a linked repository with that error and continues with the others. `resolveWorkspaceReadRevision` already records the message as `hydrateStatus: failed` / `hydrateError`, which the UI shows as "Prepare failed" with that text.
- Tests: `clone-tree.test.ts` runs against a local HTTP Git remote that answers 401 (no token and a refused token) and checks that the error message, stack and fields hold neither the token nor its Basic encoding. `workspace-tip-check.contract.test.ts` runs the real workflow against that remote and checks that the run completes and the Workspace records "no access". Both failed before the fix.

Open: the acceptance check on a preview with a private repository and access is not done here. If that Workspace has no `githubConnectionId`, connecting GitHub binds it (`bindUnboundWorkspace`).
