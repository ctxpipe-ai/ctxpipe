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

- Root cause: the SQL migration `20260820070625_purple_eddie_brock` linked every org repository to every target Workspace, also the target repositories of sibling Workspaces. `workspace-migration-export.ts` then wrote them as `repositories/*.md` into each Workspace repository. Commit 5c65eb9a deleted those links later from the tip check, and that step caused this bug.
- Fix the migration: link each other org repository only to the Workspace of the first connector target. Write the `org_first_workspaces` row in SQL.
- The tip check only records a missing first Workspace. It never adds or removes a link.

## Acceptance criteria

- [x] An org with two Workspaces, each with its own linked repository, keeps both links after several tip checks (real Postgres).
- [x] When no Workspace URL matches an org repository, the tip check changes no link and records the oldest Workspace (real Postgres).
- [x] After the first Workspace is deleted, the tip check records the next one and adds no link (real Postgres).
- [x] The migration SQL, on a fresh database with two target Workspaces, writes no sibling link and writes the `org_first_workspaces` row.

## Comments

- 2026-10-12 (review): the cause is in the migration SQL. The migration is not on `main`, so production never ran it. The team lead decided to edit it. Preview databases that ran it keep their old links; that is test data.

## Resolution

- `migrations/20260820070625_purple_eddie_brock/migration.sql`: the link insert picks one Workspace per org (the Workspace whose URL is the first connector target, by `created_at` then `id`). It links each org repository that is not a Workspace repository only to that Workspace.
- `migrations/20260825105305_organic_rhino/migration.sql` creates `org_first_workspaces`, so it also writes the row with the same rule. It makes the URL normalize function again and then drops it.
- Drizzle and edited migrations: the migrator (`drizzle-orm` `getMigrationsToRun`, used by `drizzle-kit migrate`) selects a migration by folder name only. It does not compare the stored hash. Check done: apply the old migration files to a fresh database (52 rows in `drizzle.__drizzle_migrations`), then run `drizzle-kit migrate` with the edited files. Result: "migrations applied successfully", still 52 rows, and no new `org_first_workspaces` row. So an applied database does not run the edit again and does not reject it.
- `models/workspaces.ts`: `ensureOrgFirstWorkspace` replaces the reconcile step. When the org has no row, it records the Workspace of the oldest org repository with the same normalized URL, else the oldest Workspace (`created_at`, then `id`). It writes no link. With no URL match, `source_repository_id` is an empty string, because the column is not null and no code reads it. After the row exists, each tip check reads one row and returns.
- `openworkflow/workflows/workspace-tip-check.ts` calls `ensureOrgFirstWorkspace`.
- Tests: `src/db/dest-workspace-migration.integration.test.ts` applies the real migration files to a new database. `src/models/dest-workspace-backfill.integration.test.ts` has the three runtime cases. Each test failed before its fix.
- `write-extract-native.contract.test.ts` "backfills completed path maps by native completion order despite an old completion replay" fails on the base commit too. It is not related to this change.

Open:
- `planDestWorkspaceLinks` and `applyDestWorkspaceLinkPlan` now have no runtime caller. Only tests use them (the SQL parity fixture and the seed steps of two contract tests). Remove them in a cleanup.
- `org_first_workspaces.source_repository_id` has no reader. A later schema change can drop it.
