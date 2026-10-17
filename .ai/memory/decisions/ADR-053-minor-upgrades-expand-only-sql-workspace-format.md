# ADR-053: Minor upgrades: expand-only SQL and Workspace format versions in git

**Status:** Accepted | **Date:** 2026-10-16 | **Tags:** upgrades, migrations, postgres, workspaces, git, ingestion

## Context

A minor release must not break an operator. The operator bumps the version and deploys, and the product continues to work. Hosted, Docker Compose, and AWS CDK operators take the same release.

A release can change two kinds of state:

- **The database.** Each deploy path ran its own migrate command, so some paths skipped steps. Some SQL changes (a dropped table, a new constraint) break the previous release after a rollback.
- **The Workspace repository.** The layout of a Workspace repository changes over time ([ADR-050](ADR-050-workspace-sources-config-file.md), [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md)). No record told which layout a repository has. A change to the repository is a change to customer content, so it needs review.

## Decision

### 1. One migrate entry point

All deploy paths run the same migrate command before the new code serves traffic. The command provisions the app role, runs the Drizzle and OpenWorkflow migrations, runs every backfill, and grants. A second run changes nothing. Role provisioning stays in code, not in a SQL migration ([ADR-042](ADR-042-postgres-rls-app-role.md)).

### 2. Expand-only SQL in a minor

- A minor release only adds: tables, nullable columns, policies, triggers, and rows. It does not drop a table or a column that the previous release reads. It does not add a constraint that the previous release can break.
- Thus the previous image can run on the upgraded database after a rollback.
- The contract step (drop, `NOT NULL`, removal of legacy reads) waits for the next major.
- A data repair that a minor needs is an idempotent backfill in the migrate command, not a manual step.

### 3. The Workspace format lives in git

- Each Workspace repository holds `.ctxpipe/workspace.yaml` below its root folder. The file holds one integer and no other key:

  ```yaml
  format: 3
  ```

- No file is format 0. One strict schema validates the file for the backend and the UI.
- Git is the source of truth. The database holds only a cache of the format, which hydrate writes for each revision ([ADR-046](ADR-046-workspace-revision-projection-identity.md)). Thus a rebuilt database gets the same format at the next hydrate.
- The format file is host-only. Only bootstrap (the root commit of a new repository) and an upgrade pull request write it.
- The code declares the newest format that it supports (`CODE_FORMAT`).
  - A format above `CODE_FORMAT` (for example after a rollback) makes the Workspace read-only. Reads continue. No upgrade is offered.
  - A file that does not parse makes the Workspace read-only. Reads continue.
- **Compatibility rule.** The code of a minor reads every format from 0 to `CODE_FORMAT`. A writer that needs a newer layout checks the format and refuses below it. The removal of a dual read waits for the next major.

### 4. Upgrade steps in a registry

- The code holds the git upgrade steps in an ordered registry. Step N changes the layout from format N-1 to format N. The steps are contiguous from 1 to `CODE_FORMAT`, with no gap. A test proves this.
- A step is a pure plan over the Workspace tree. A second plan on its own output changes nothing.
- All pending steps of a Workspace go into one pull request on a dedicated upgrade branch, with one commit for each step that changes a file. Each step reads the tree that the step before it made. The last commit writes the new format. Thus a merge lands the files and the format together, and they cannot disagree.
- An upgrade never pushes to the default branch.
- Each later layout change is a new format and a new registered step. [ADR-050](ADR-050-workspace-sources-config-file.md) and [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md) record the steps of the current formats.

### 5. Re-ingestion is an upgrade step

- A fresh ingestion from the source repositories is an upgrade item like a git step. It is the standard way to bring knowledge to the current ingestion, not an optional extra.
- It costs model money, so the operator sees an estimate before the start.
- A knowledge export from the database keeps only the content that a fresh ingestion cannot rebuild, and it goes only into the upgrade pull request, never directly to a default branch.
- Each Workspace with a GitHub source repository needs it once for each skill bundle. It needs format 3 or higher, so that the ingestion v2 publish is allowed.
- Re-ingestion is throttled for each org (see [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md), revision 2026-10-16).

### 6. Git holds the upgrade state

- The upgrade state comes from git: the format file and the open upgrade pull requests. Database rows only cache it and log the runs. There is no new upgrades table.
- A scan after each deploy finds the pending upgrades of each Workspace and records them. When the rows are lost, the next scan makes them again.

### 7. An operator starts each upgrade

- Nothing changes a Workspace repository or starts a paid run automatically. This applies to hosted too. There is no setting for automatic approval, and no org-wide approval.
- An org owner or admin starts each upgrade item of a Workspace in the UI. A merge of the upgrade pull request is a second human approval.
- Data work that changes no Workspace repository (for example the retirement of old workflows) runs in the migrate command or the worker, with no click.

## Consequences

- An operator upgrades with a version bump and a deploy. The SQL runs automatically and only adds.
- A rollback to the previous image is possible without a database restore ([ADR-042](ADR-042-postgres-rls-app-role.md) holds the procedure). A Workspace that was upgraded keeps its new format, and the old code shows it as read-only.
- Below format 3: no ingestion; existing knowledge stays readable. Until an operator merges the upgrade pull request and runs the re-ingestion, MCP and the UI serve only what the Workspace and the org already hold. The UI shows the pending work.
- The code of each minor keeps the dual reads of all older formats. The next major removes them.
- The format and the upgrade state survive the loss of the database.

## Alternatives considered

- **The format only in the database:** rejected. A rebuilt database loses it, and git is the source of truth for a Workspace.
- **A list of applied upgrade ids in the format file:** rejected. An order is enough, and an integer cannot drift.
- **A new upgrades table:** rejected. Git holds the state; rows are a cache.
- **A direct commit of an upgrade to the default branch:** rejected. A change to customer content needs review, and the format must land with the files.
- **Automatic upgrades (for hosted, or with a setting):** rejected. Each repository change and each paid run needs a human decision.
- **Org-wide auto-approval:** rejected. Each Workspace has its own repository and its own review.
- **Re-ingestion as an optional extra:** rejected. The new ingestion gives much better knowledge, so every upgrade runs it.
- **A quarantine copy of rows that a migration deletes:** rejected. Rows with no org have no owner, so no one can use them.
- **A SQL migration that creates the app role:** rejected. The role needs a password and safety checks, and a managed role owner can conflict with a SQL `CREATE ROLE`.
