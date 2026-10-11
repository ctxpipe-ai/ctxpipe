# The tip check deletes the linked repositories of each Workspace except the first

Status: ready-for-human
Priority: P0
Owner: unassigned
Blocked by: none
Created: 2026-10-12
Updated: 2026-10-12

## Context

A review of PR 280 found this bug. It is on PR 280 only, not on `main`.

Commit 5c65eb9a ("Make Workspace data and isolation honest.") added `reconcileDestWorkspaceAssignment` in `apps/backend/src/models/workspaces.ts`. The commit message says it corrects the "dest-workspace link cardinality" and persists the first-target identity (`org_first_workspaces`). It removed the runtime cutover job, and it called the reconcile step from `openworkflow/workflows/workspace-tip-check.ts` on each tip check run. No other code writes `org_first_workspaces`. `getOrgFirstWorkspace` reads it for the deprecated `ctx_advisor` MCP tool and for `captureRepositoryExtractionTarget`.

The spec is a one-time migration step, not a cron step. See `.ai/scratchpad/git-backed-projects/map.md` (decision "Workspace identity and invariants": "migration links non-target ingested repos to the first connector-target Workspace") and `.ai/scratchpad/git-backed-projects/issues/12-first-project-migration.md` (Q1: "Persist first Workspace id at migration start so a later binding does not move the set").

## Evidence

- The planner `planDestWorkspaceLinks` (`domain/workspaces/dest-workspace-assignment.ts`) made the wanted link set only for the first connector-target Workspace of the org. It returned every other link of the org in `deleteLinkIds`, and it added each non-target org repository to the first Workspace.
- Scenario: Workspace B has `repositories/api.md`. Hydrate of B links `api`. The next tip check deletes that link and adds `api` to Workspace A. The next hydrate of A removes it. The links change on each cron run.
- The model found the connector targets with a raw `===` on URLs. When no Workspace URL is equal to a `repositories` row (for example `https://github.com/acme/a` and `https://github.com/acme/a.git`), `firstWorkspaceId` was `null`, the wanted set was empty, and the tip check deleted every link in the org.

## Expected vs actual

- Expected: each Workspace keeps the links that its hydrate writes. The dest-Workspace assignment runs one time per org.
- Actual: each tip check deletes the links of every Workspace except the first, or every link when no URL matches exactly.

## Scope

- Keep the step in the tip check, because it is the only place that persists the first Workspace of a migrated org. Make it a one-time backfill (`backfillDestWorkspaceAssignment`): do nothing when the org has an `org_first_workspaces` row.
- Never delete a link. Remove `deleteLinkIds` from the plan.
- Normalize URLs when the model finds the connector targets.
- Do not add a repository that a Workspace already links.

## Acceptance criteria

- [x] An org with two Workspaces, each with its own linked repository, keeps both links after several tip checks (real Postgres).
- [x] When no Workspace URL matches an org repository, the step deletes no link and persists no first Workspace (real Postgres).

## Comments

## Resolution

- `models/workspaces.ts`: `reconcileDestWorkspaceAssignment` is now `backfillDestWorkspaceAssignment`. It returns at once when the org has a first Workspace. It matches Workspace and repository URLs with `normalizeWorkspaceRepositoryUrl`. It persists the first Workspace and inserts links only when it finds a first Workspace. `applyDestWorkspaceLinkPlan` no longer deletes.
- `domain/workspaces/dest-workspace-assignment.ts`: the plan has no `deleteLinkIds`. It inserts a link only for a non-target repository that no Workspace links yet.
- `openworkflow/workflows/workspace-tip-check.ts` calls the backfill. The brief asked to remove the call. The call stays because nothing else writes `org_first_workspaces` for an org that the SQL migration created, but after the first successful run it reads one row and returns.
- Test: `models/dest-workspace-backfill.integration.test.ts` (real Postgres). Both cases failed before the fix: the old code deleted both links in each case.
- `write-extract-native.contract.test.ts` "backfills completed path maps by native completion order despite an old completion replay" fails on the base commit too. It is not related to this change.

Open: a new org gets its first Workspace row from the first tip check after it has a Workspace whose URL is an org repository. If the product wants the first Workspace to be the first one that the user creates, persist it on Workspace create instead.
