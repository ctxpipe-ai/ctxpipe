# ADR-053: Minor upgrades: expand-only SQL and Workspace format versions in git

**Status:** Accepted | **Date:** 2026-10-16 | **Tags:** upgrades, migrations, postgres, workspaces, git, openworkflow, aws-cdk, compose, ingestion

## Context

PR 280 (git-backed Workspaces) must ship as a minor, non-breaking release. An operator bumps the version and deploys, and everything continues to work. Hosted, Compose and CDK operators all take the same release.

The branch had some changes that break a plain version bump:

- SQL that deletes or locks main data: `NOT NULL` on `org_id` of main tables, a drop of the LangGraph checkpoint tables, and a silent skip of the app-role provisioning when no password is set.
- Hosted ran `drizzle-kit migrate` directly, so it skipped the backfills of `src/db/migrate.ts`.
- A queued `sync-github-repositories` run from main has no registered workflow after the upgrade, so the worker retries it forever.
- The knowledge export pushed to the default branch of a Workspace repository with no review, and retried every minute when it had no write access.
- Nothing started the Workspace work after a deploy. Only a webhook, a GET or a button started a tip check.
- The Workspace repository layout changed three times (knowledge export, `sources/*.md` from [ADR-050](ADR-050-workspace-sources-config-file.md), and ingestion v2 ownership from [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md)). No record told which layout a repository has.
- Ingestion in PR 280 is much better than on main. Knowledge that the old pipeline wrote is less good than a fresh ingestion.

The design is the Linear document [PR 280 minor upgrade and workspace migrations — design](https://linear.app/ctxpipe/document/pr-280-minor-upgrade-and-workspace-migrations-design-2e2f14ea3623). The epic is [CTX-734](https://linear.app/ctxpipe/issue/CTX-734). The CTO decisions G1 to G8 of 2026-10-16 are on the epic. Section "CTO decisions" below records them.

## Decision

### 1. One migrate entry point

- Hosted, Compose and CDK run the same command: `bun run apps/backend/src/db/migrate.ts`. The steps are: provision the app role, then the Drizzle migrations, then the OpenWorkflow migrations, then every backfill, then the grants.
- Role provisioning stays in code (`provision-app-role.ts`), not in a Drizzle migration. It has three modes ([ADR-042](ADR-042-postgres-rls-app-role.md), revision 2026-10-16):
  - (a) A password is given: create or alter the role, then grant.
  - (b) No password, and the role exists: grants and `ALTER DEFAULT PRIVILEGES` only. Hosted uses this mode, because Terraform owns the password.
  - (c) No password, and no role: exit with code 1, with the fix text for each deploy path.
- A second run changes nothing.

### 2. Expand-only SQL in a minor

- A minor release adds tables, columns, policies and rows. It does not drop a table or a column that main code reads, and it does not add a constraint that main code can break. These changes wait for the next major (the contract step).
- In this release:
  - `chunky_shocker` keeps the `DELETE` of orphan rows (rows with no org) in `claim_evidence`, `confluence_spaces` and `repository_checkouts`. The delete runs in the same transaction as the migration, so a failed migration keeps the rows. There is no copy of these rows (G3).
  - `chunky_shocker` does not set `NOT NULL` on `org_id` of main tables. RLS stays enabled, so the app role does not see rows with a NULL `org_id`. The next major sets `NOT NULL`.
  - After a rollback, the main image writes rows with no `org_id` into `claim_evidence`, `confluence_spaces` and `repository_checkouts`. `chunky_shocker` adds a `BEFORE INSERT` trigger on each of these tables. The trigger copies `org_id` from the parent row when it is NULL. It runs with the rights of the caller, so RLS on the parent applies. The function `backfillNullOrgIds` repairs the other rows with no `org_id`. It is idempotent, and every deploy path runs it after the migrations. The next major drops the triggers.
  - The folder `drop_langgraph_checkpoint_tables` goes out of this release. The next major drops the LangGraph tables.
  - The only new column is the nullable cache column `workspaces.format_version` (G7).
- No PR 280 migration ran in production, so the team edits the branch migrations in place. The Drizzle migrator selects migrations by folder name, so the branch folders still run on a main database. Preview and dev databases must be reset.
- The next major sets `NOT NULL` on `org_id` of the main tables, and drops the LangGraph tables, `repository_extraction_captures` ([ADR-052](ADR-052-ingestion-sandbox-skills-patches.md) phase 5), and the legacy reads of `repositories`.

### 3. The Workspace format file is the source of truth

- Each Workspace repository has `.ctxpipe/workspace.yaml` below its root folder ([ADR-046](ADR-046-workspace-revision-projection-identity.md), revision 2026-10-15). The file holds one integer and no other key:

  ```yaml
  # ctx| Workspace format. ctx| changes this file only in an upgrade pull request.
  format: 3
  ```

- One strict Zod schema (`domain/workspaces/workspace-format.ts`) validates the file for the backend and the UI. It uses the same YAML limits as the sources file.
- `.ctxpipe/` is host-only. No agent or chat write can change the file. Only the upgrade workflow (in a pull request) and bootstrap (in the root commit of a new repository) write it.
- The formats of this release:

  | Format | Layout |
  | --- | --- |
  | 0 | No file: a main-era repository or a foreign repository |
  | 1 | Knowledge from Postgres that fresh ingestion cannot rebuild is exported. Connection scopes and org repositories are sources. `repositories/*.md` is removed |
  | 2 | One Markdown file for each source under `sources/` ([ADR-050](ADR-050-workspace-sources-config-file.md), revision 2026-10-16) |
  | 3 | Ingestion v2 ownership front matter ([ADR-052](ADR-052-ingestion-sandbox-skills-patches.md) section 3) |

  `CODE_FORMAT` is 3.
- Hydrate reads the file at the revision SHA and records the format in `workspaces.format_version`. The column is a cache. Git stays the truth: a rebuilt database gets the same value at the next hydrate.
- A file that does not parse makes the Workspace read-only with the reason `format_invalid`. Hydrate still serves it. The UI offers a "Repair" pull request that writes the detected format.
- A format above `CODE_FORMAT` (for example after a rollback) makes the Workspace read-only with the reason `format_ahead`. Hydrate and the read paths still serve it. No upgrade is offered.
- **Code compatibility rule:** the code of a minor reads every format from 0 to `CODE_FORMAT`. A writer that needs a layout checks the format and refuses below it with "Upgrade this Workspace first". The removal of a dual read waits for the next major.
- A new Workspace on a new repository gets `format: CODE_FORMAT` in its root commit. A new Workspace on an existing repository opens the upgrade pull request at once, because the user started that action.

### 4. Upgrade steps and the registry

- `domain/upgrades/registry.ts` holds the upgrades in code:
  - A **git upgrade step** has a `format` N and a pure `plan(tree)` that returns writes, deletes and a report. It runs only when the file reads N-1, and its commit sets `format: N`. The steps are contiguous from 1 to `CODE_FORMAT`. A test proves that the steps are contiguous and that a second `plan` on its own output changes nothing.
  - A **re-ingestion upgrade** has a key, a minimum format (3), a `needed` rule and an estimate.
- Step 1 holds the knowledge export and the source migration. Step 2 is the conversion to `sources/*.md`. Step 3 is the ownership migration of ingestion v2. `migrateWorkspaceSources.ts` and the `migration_export` write kind become thin wrappers, then go away.
- All pending git steps of a Workspace go into one pull request on the branch `ctxpipe/upgrade/format-<target>`, with one commit for each step. Each step reads the tree that the step before it made. A step with no change makes no commit; a final commit writes the format file. A merge lands the files and the format together, so they cannot disagree.
- Git upgrades never push to the default branch. The upgrade workflow force-updates only its own upgrade branch.

### 5. Fresh re-ingestion is a standard upgrade step (G1)

- Every upgrade from main runs a fresh ingestion from the source repositories (ingestion v2, [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md)). It is part of the standard upgrade flow, not an optional extra.
- An operator click starts it, and the UI shows a cost estimate first. Nothing starts it automatically.
- The upgrade key is `reingest-<bundle>`, where `<bundle>` is the name of the skill bundle (its content hash). Every Workspace that has a GitHub source repository needs the re-ingestion once for each bundle. A completed row keeps it done until a release ships a new bundle. This rule includes each Workspace with legacy `generated_by: ctxpipe` units or units of an old `bundle`, and it does not read the units.
- Re-ingestion needs format 3 or higher (G5). Below 3 the item is `blocked: needs_format`. It is also `blocked: ingestion_v2_off` while the committed publish pipeline is not `v2`, because a run outside shadow mode cannot publish then.
- The estimate (CTX-746): the database has no `ingestion_runs` table and keeps no model spend; the spend is only in the Langfuse traces. So, for each repository, the root count (the `discover-roots` step output) and the wall time come from its last finished ingestion v2 run in `openworkflow.workflow_runs`. Without such a run, the root count is a committed range. The cost is the model steps (the roots times the root model skills of the bundle, plus the repository model skills) times a committed per-step cost range. The scan stores the estimate on the row, and the API returns it on the item, with a range (p50 to p90), the minutes and the number of repositories.
- Throttle (committed config in `domain/upgrades/reingest.ts`, not env vars): one Workspace of an org runs at a time, and it runs one source repository at a time, so an org runs at most one repository. This is inside the limit of 2 repositories for each org and the ADR-052 limit of 40 ingest sandboxes. An instance runs at most 4 re-ingestion repositories at a time. An advisory lock makes the slot check and the start of the ingestion v2 run one action. A run that waits for a slot sleeps and checks again.
- The per-run cost cap (stop a run before a step that goes above 2 times the p90 estimate, then `failed: budget`) is not built yet. It needs a place to count the spend of a run.
- Without a Docker ingest sandbox host, the item is `blocked: sandbox_unavailable`.
- **An org with no Workspace (G2).** When an org has GitHub data but no Workspace after the upgrade (an MCP-first org with no connector sync repository), it is a new user. It goes through the normal onboarding and creates its Workspace there. Its repositories get a fresh ingestion from onboarding, so the upgrade does not export its old Postgres knowledge, and the upgrade flow adds no step for it.
- The Postgres knowledge export of step 1 keeps only the content that fresh ingestion cannot rebuild, for example knowledge that a person wrote or knowledge that only a connector gave. The builder of [CTX-743](https://linear.app/ctxpipe/issue/CTX-743) names that content exactly and records it in this ADR.

### 6. Jobs and workflows

- There is no new table. An upgrade run is a `workspace_write_jobs` row of kind `upgrade`.
  - The id is deterministic: `wju_<workspaceId>_<upgradeKey>`, where `upgradeKey` is `format-<target>` or `reingest-<bundleHash>`. A second insert does nothing.
  - The statuses are `awaiting_operator`, `queued`, `running`, `pr_open`, `completed`, `failed` and `blocked`.
  - The typed JSONB payload holds the keys, the formats, the pull request, the estimate, the approver, and the block or failure reason.
  - The rows are a cache of git and a run log. The upgrade state comes again from the format file and the open pull requests (found by branch prefix). When the rows are lost, the scan makes them again.
- `workspace-upgrade-scan` runs once for each org and release (idempotency key `upgrade-scan:<org>:<release>`). The worker-start backstop in `openworkflow.config.ts` enqueues it, as do the tip check and the pull request webhook. The scan:
  - runs `ensureOrgFirstWorkspace`;
  - enqueues a tip check for each Workspace, staggered with `availableAt`;
  - sets required data work to `queued`, git steps and re-ingestion to `awaiting_operator`, and a Workspace with no write access to `blocked: write_access`.
- `workspace-upgrade` runs one job: claim, acquire the revision, read the format, plan, open or update the pull request, and record it. After a merge, the read format reaches the target and the job is `completed`. A pull request that closes with no merge sets the job back to `awaiting_operator` with a note.
- **Required data work runs with no approval:** the retired workflow stubs (for example `sync-github-repositories`, which ends as `retired`), the cancel of old link runs (CTX-731), the first hydrate, and the legacy connector handover gate for every provider ([ADR-050](ADR-050-workspace-sources-config-file.md), revision 2026-10-16: upgrade format 1). This work changes no Workspace repository.

### 7. UI and permissions

- **Workspace settings, "Upgrades" section:** the current format and the code format; each pending item with its state; one button for each item ("Open upgrade PR", or "Start re-ingestion" with the estimate); and a health line for the chat sandbox.
- **Home page:** one alert for each Workspace that has a pending item, with a link to its settings. Members see "Ask an admin".
- **Nothing runs automatically (G1).** Hosted users get the same UI workflow as every other operator. There is no setting that opens upgrade pull requests automatically.
- **No org-wide auto-approval (G8).** Each item needs its own click. A pull request merge is a human approval too.
- Org owners and admins may open upgrade pull requests and start re-ingestion. The API is `POST /v1/workspaces/{id}/upgrades/{key}:start`, with a session and `requireWriteGrant`. GitHub branch rules control the merge.
- **API-key writes get 403 (G4)** on the new direct-write routes (`requireWriteGrant`). These routes are new, so nothing that worked on main breaks. A write permission on API keys can come later ([ADR-051](ADR-051-mcp-read-surface.md)).

### 8. Ingestion v2 publish gate (G5)

The ingestion v2 publish runs for a Workspace only when its format is 3 or higher. Below 3, the legacy pipeline stays for that Workspace. The global rollback switch of [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md) phase 4 stays too.

### 9. Self-host differences

- The same code, workflows and migrate entry point run on every path. The scan starts from the OpenWorkflow worker.
- A GitHub App with no Contents or Pull requests write permission makes the Workspace `blocked: write_access`. The docs list the exact permissions. The banner and "Check write access" stay.
- **CDK sandbox host (G6):** the chat and ingest sandbox host is on by default, with a prop to turn it off. The default instance size puts the cost in the bottom half of the range of $28 to $107 a month. The builder of the CDK ticket picks the size and states the estimate in the release note.

## CTO decisions (2026-10-16)

| Id | Decision |
| --- | --- |
| G1 | Nothing runs automatically. Hosted users get the same upgrade UI workflow as everyone else. There is no auto-open-PR setting. Fresh re-ingestion from the source repositories is a standard upgrade step: an operator click starts it, with a cost estimate. The Postgres knowledge export stays only for content that fresh ingestion cannot rebuild. |
| G2 | An org that has GitHub data but no Workspace after the upgrade (an MCP-first org with no connector sync repository) is a new user. It goes through the normal onboarding and creates its Workspace there. Its repositories get a fresh ingestion in any case, so its old Postgres knowledge is not exported. The upgrade flow adds no step for it. |
| G3 | Keep the `DELETE` of orphan rows. The migration deletes them in its own transaction, so they go only when the migration succeeds. No quarantine schema. |
| G4 | API-key writes on the new direct-write routes get 403. |
| G5 | The ingestion v2 publish needs format 3 or higher for each Workspace. |
| G6 | The CDK sandbox host is on by default, with a prop to turn it off. The default size costs in the bottom half of $28 to $107 a month. |
| G7 | Add the nullable cache column `workspaces.format_version`. Git stays the truth. |
| G8 | No org-wide auto-approval. |

## Consequences

- An operator upgrades with a version bump and a deploy. The SQL runs by itself and only adds, except the orphan-row delete of G3. Each change to a Workspace repository and each paid run waits for a click.
- There is a context gap: until an operator merges the upgrade pull request and runs the re-ingestion, MCP serves only what the Workspace already has. The home alert and the Upgrades section show the pending work.
- A rollback to the main image is safe with the owner database URL, because the minor adds no constraint that main code breaks. The rollback runbook is in [ADR-042](ADR-042-postgres-rls-app-role.md).
- Fresh re-ingestion costs model money for each org that upgrades. The estimate, the click, the throttle and the cost cap control it.
- Each later layout change is a new format and a new registered step. The dual reads stay until the next major.
- Orphan rows are gone after the upgrade, and no copy stays.
- An MCP-first org with no Workspace loses its old Postgres knowledge at the upgrade. Its fresh ingestion in onboarding makes it again from the source repositories.

## Alternatives considered

- **A quarantine schema for orphan rows** (copy the rows to `ctxpipe_quarantine`, then delete): rejected by the CTO (G3). The rows have no org, so no one can use them.
- **An auto-open-PR setting** (`CTXPIPE_UPGRADES_AUTO_OPEN_PRS`) for hosted or self-host: rejected by the CTO (G1). Hosted uses the same click as everyone else.
- **Re-ingestion as an optional extra:** rejected by the CTO (G1). The new ingestion is much better, so every upgrade runs it.
- **Org-wide auto-approval:** rejected by the CTO (G8).
- **A new upgrades table:** rejected. `workspace_write_jobs` rows and git hold the state.
- **The format only in the database:** rejected. A rebuilt database would lose it, and git is the source of truth for a Workspace.
- **A list of applied upgrade ids in the format file:** rejected. An order is enough, and an integer cannot drift.
- **A Drizzle migration that creates the app role:** rejected. The role needs a password and safety checks, and on Neon Terraform owns the role, so a SQL `CREATE ROLE` breaks a new preview branch.
- **An org-level upgrades panel:** rejected. The upgrades are per Workspace.
- **A `ctx_advisor` MCP shim:** rejected by the CTO. Clients reload `tools/list`, so the removal does not break them.
- **A choose-or-create context repository upgrade step for orgs with GitHub data but no Workspace:** rejected by the CTO (G2). Normal onboarding does the same work, and a fresh ingestion makes the knowledge again.
- **A direct commit of the knowledge export:** rejected. The export goes through the upgrade pull request, because it changes the format file.
