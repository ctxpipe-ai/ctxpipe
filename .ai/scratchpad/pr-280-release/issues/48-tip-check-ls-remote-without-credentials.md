# workspace-tip-check fails on a private repository: git ls-remote runs without credentials

Status: ready-for-agent
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
