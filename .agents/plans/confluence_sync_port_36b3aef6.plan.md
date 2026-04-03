---
name: Confluence Sync Port
overview: Port Confluence content/config sync behavior from `cc/4-scope-ui` into the current Forge + GitHub App architecture, preserving setup/scope UX separation and avoiding legacy connector tables.
todos:
  - id: schema-align
    content: Align data model for sync targets and sync run logs without reintroducing generic connectors
    status: pending
  - id: service-layer
    content: Introduce Confluence sync service modules adapted to Forge token + current route/model patterns
    status: pending
  - id: github-writes
    content: Implement GitHub App installation-based write utilities and PR/commit flows
    status: pending
  - id: workflow-triggers
    content: Add OpenWorkflow jobs and API triggers for content sync + config sync
    status: pending
  - id: safety-idempotency
    content: Add deletion guards, retry/partial-failure handling, and per-space sync state updates
    status: pending
  - id: tests-validation
    content: Add unit/integration tests and run end-to-end validation checklist
    status: pending
isProject: false
---

# Confluence Sync Port Plan

## Scope

Port behavior from `cc/4-scope-ui` Confluence sync into current backend architecture using Forge install token + GitHub App installations, while keeping:

- setup prerequisites (`Atlassian install`, `GitHub install`) separate from editable scope,
- existing GitHub linking verification unchanged (`getGithubUserAccessToken` + `userCanAccessInstallation` in registration flow),
- no generic `connectors` table.

## File-by-File Implementation Plan

- **Data model + models**
  - Add target mapping table file: `[apps/backend/src/db/schema/confluenceSyncTargets.ts](apps/backend/src/db/schema/confluenceSyncTargets.ts)`
    - Columns: `id`, `org_id`, `forge_installation_id`, `repository_name`, `branch`, `enabled`, timestamps.
    - Managed content root path is an internal constant (`confluence/`) in sync services (not stored as user-editable target config).
    - Constraints: unique `org_id` (exactly one Confluence sync target per org).
    - FK: `forge_installation_id -> forge_installations.id` (cascade).
  - Update schema export: `[apps/backend/src/db/schema.ts](apps/backend/src/db/schema.ts)`
    - Export new table.
  - Add model modules:
    - `[apps/backend/src/models/confluence-sync-target.ts](apps/backend/src/models/confluence-sync-target.ts)`
    - Include transaction-safe CRUD and query helpers.
- **Confluence service layer (ported/adapted)**
  - Create service folder: `[apps/backend/src/services/confluence/](apps/backend/src/services/confluence/)`
  - Add `[client.ts](apps/backend/src/services/confluence/client.ts)`
    - Port old Confluence fetch/pagination/search behavior, but **adapt auth** to Forge app system token only.
    - Use existing base URL resolver from `[apps/backend/src/lib/atlassian-api-base-url.js](apps/backend/src/lib/atlassian-api-base-url.js)`.
  - Add `[converter.ts](apps/backend/src/services/confluence/converter.ts)`
    - Port markdown conversion logic; adapt file naming to avoid slug collisions (append page id suffix, e.g. `.../<slug>--<pageId>.md`).
  - Add `[config-yaml.ts](apps/backend/src/services/confluence/config-yaml.ts)`
    - Port generation of `confluence/config.yaml` and PR message behavior.
  - Add `[sync.ts](apps/backend/src/services/confluence/sync.ts)`
    - New orchestrator keyed by `(orgId, forgeInstallationId, syncTarget)` instead of `connectorId`.
    - Execution model: one run per org's single target, iterating selected rows in `confluence_spaces` for that Forge install.
    - Reuse old deletion behavior but guard to target root path only.
- **GitHub write strategy utilities**
  - Add `[apps/backend/src/services/github/installation-write-client.ts](apps/backend/src/services/github/installation-write-client.ts)`
    - Wrap Octokit git/contents/pulls APIs using GitHub App installation context.
    - Input uses org-level installation lookup (`getInstallationByOrgId`) and target `repository_name` + `branch`.
    - Expose operations needed by sync: `listFilesInTree`, `commitFiles`, `createPullRequestWithFiles`, `getFileContent`.
  - Optional small addition in `[apps/backend/src/models/github-installation.ts](apps/backend/src/models/github-installation.ts)`
    - Add helper to return installation-scoped Octokit for reuse (keeps token retrieval logic centralized).
- **OpenWorkflow jobs + triggers**
  - Add workflows:
    - `[apps/backend/src/openworkflow/confluence-sync-content.ts](apps/backend/src/openworkflow/confluence-sync-content.ts)`
    - `[apps/backend/src/openworkflow/confluence-sync-space.ts](apps/backend/src/openworkflow/confluence-sync-space.ts)`
    - `[apps/backend/src/openworkflow/confluence-sync-config.ts](apps/backend/src/openworkflow/confluence-sync-config.ts)`
  - Workflow responsibilities:
    - parent `confluence-sync-content` resolves org config/target and fans out child workflows for each selected space in `confluence_spaces`,
    - child `confluence-sync-space` handles one space sync unit (full or incremental mode) and returns/apply per-space results,
    - parent aggregates child outcomes and performs final target write orchestration as needed,
    - log outcome (`completed|partial_failed|failed`) with counters + commit/PR metadata to OpenWorkflow/structured app logs (no DB run-log table),
    - retry transient API/GitHub failures with bounded backoff.
  - Trigger sources:
    - `POST /config`: run full org sync (all selected spaces) after config persistence succeeds.
    - Atlassian webhooks: run incremental sync for affected space/page via child workflow.
  - For future webhook reuse, design `confluence-sync-space` input to support incremental mode (`spaceKey`, optional `pageId`, `eventType`) so `[apps/backend/src/routes/webhooks/atlassian/atlassian.ts](apps/backend/src/routes/webhooks/atlassian/atlassian.ts)` can dispatch the same child workflow directly.
- **API integration in Atlassian connector routes**
  - Extend `[apps/backend/src/routes/v1/connectors-atlassian.ts](apps/backend/src/routes/v1/connectors-atlassian.ts)` with:
    - `GET /config` (read consolidated Atlassian connector config: scope + single sync target)
    - `POST /config` (transactionally save consolidated config: scope + single sync target)
  - Keep existing `/installation`, `/status`, `/available-spaces`* behavior intact; replace `/scope` read/write usage with `/config`.
  - Trigger strategy: `POST /config` returns `202` after persisting config + enqueuing full sync in OpenWorkflow. There is no separate manual sync endpoint. Maintainer debugging uses OpenWorkflow/app logs.
- **Webhook handoff prep**
  - In `[apps/backend/src/routes/webhooks/atlassian/atlassian.ts](apps/backend/src/routes/webhooks/atlassian/atlassian.ts)`, replace current no-op Confluence event handling with enqueue-ready hook call.
  - Map incoming event to target(s) via `forge_installation_id`, then run incremental workflow mode.
- **UI updates for single target configuration**
  - Update connectors types: `[apps/ui/src/features/connectors/types.ts](apps/ui/src/features/connectors/types.ts)`
    - Add `ConfluenceSyncTarget` and consolidated `AtlassianConnectorConfig` response/request types for `/config`.
  - Keep scope-only modal for scope management: `[apps/ui/src/features/connectors/EditScopeModal.tsx](apps/ui/src/features/connectors/EditScopeModal.tsx)`
    - Keep this screen focused on scope selection/editing only.
    - It should read existing scope via `/config` and submit `POST /config` preserving existing target fields.
  - Update connectors route wiring: `[apps/ui/src/routes/$orgSlug.connectors.tsx](apps/ui/src/routes/$orgSlug.connectors.tsx)`
    - Keep the same entry points: setup flow for prerequisites/target, scope modal for scope edits.
  - Update setup status display: `[apps/ui/src/features/connectors/components/ConnectorSetupDialog.tsx](apps/ui/src/features/connectors/components/ConnectorSetupDialog.tsx)`
    - Add sync-target step after Forge app install + GitHub app install, with fields (`repositoryName`, `branch`, `enabled`).
    - Persist target as part of setup using `POST /config` (can send current/empty spaces if none selected yet).
    - Surface whether sync target is configured so flow clearly indicates "installed but missing target" vs "fully configured".

## Data Model Alignment Decisions

- `**confluence_sync_targets` usage**
  - Canonical mapping row for where scoped Confluence content goes:
    - `org_id + forge_installation_id + repository_name + branch`.
  - Enforce exactly one target row per org (single GitHub repo/branch destination).
- **Need for sync-log replacement**
  - No dedicated DB sync-log table.
  - Use OpenWorkflow execution records + structured backend logs for debugging/observability.
- **Execution unit mapping**
  - Primary unit: `(org_single_sync_target, confluence_space)`.
  - Parent run unit: one `confluence-sync-content` execution per trigger for that org target (`/config` update full sync).
  - Child run unit: one `confluence-sync-space` execution per selected space.
  - Webhook future: dispatch `confluence-sync-space` directly in incremental mode for `(sync_target, space, optional page)`.

## Endpoint Contract Changes

- **New request/response schemas in** `[apps/backend/src/routes/v1/connectors-atlassian.ts](apps/backend/src/routes/v1/connectors-atlassian.ts)`
  - `ConfluenceSyncTargetSchema`: `{ id, orgId, forgeInstallationId, repositoryName, branch, enabled, createdAt, updatedAt }`
  - `AtlassianConnectorConfigSchema`: `{ spaces: ConfluenceScopeRow[], syncTarget: ConfluenceSyncTarget | null }`
  - `AtlassianSaveConfigRequestSchema`: `{ spaces: Array<{ spaceKey, spaceName?, selectedPageIds? }>, syncTarget: { repositoryName, branch, enabled } }`
- **New endpoints**
  - `GET /:orgSlug/api/v1/connectors/atlassian/config`
  - `POST /:orgSlug/api/v1/connectors/atlassian/config`

## GitHub Write Strategy

- Use GitHub App installation token derived from org installation (no user token for writes).
- Required GitHub App permissions:
  - `Contents: Read & Write` (read tree/write commits/files)
  - `Pull requests: Read & Write` (config PR flow)
  - `Metadata: Read` (repo metadata)
- Reuse existing installation registration/verification as-is in `[apps/backend/src/routes/v1/github-installation.ts](apps/backend/src/routes/v1/github-installation.ts)` and `[apps/backend/src/models/github-installation.ts](apps/backend/src/models/github-installation.ts)`.
- Strategy:
  - **Content sync:** direct commit to target branch (default).
  - **Config sync:** PR-only when `confluence/config.yaml` differs (carry over old behavior).

## Safety, Idempotency, and Failure Strategy

- **Deletion safety**: only delete files under the internal managed root (`confluence/`), never outside.
- **Idempotency**: deterministic pathing + stable YAML generation + skip commit when no file changes.
- **Retries**: workflow-level retries for transient HTTP/API failures; no infinite loops.
- **Partial failure**: continue other spaces, mark run `partial_failed`, persist per-space errors.
- **State updates**:
  - keep existing `confluence_spaces.lastSyncedAt/lastSyncedPageId` updates,
  - rely on OpenWorkflow execution timestamps/logs for run-level audit.

## Migration Plan

- Add Drizzle schema file(s) listed above (`confluence_sync_targets` only).
- Generate migration via `pnpm run db:generate` (no manual SQL).
- Apply via existing migration flow.

## Test Matrix

- **Unit tests**
  - Confluence client pagination + filtering + schema parse fallback.
  - Converter markdown + deterministic pathing (slug collision with page ID suffix).
  - Config YAML generation + no-change diff detection.
  - GitHub installation write client commit/tree/PR utilities (mocked Octokit).
- **Integration tests**
  - Route auth/permissions for new `connectors-atlassian` config endpoint (`GET/POST /config`) and webhook-triggered sync path.
  - UI integration for setup + scope split:
    - setup dialog captures/saves single sync target after Forge+GitHub prerequisites,
    - scope modal loads/saves scope via `/config` without requiring target re-entry,
    - both screens reflect `/config` state consistently.
  - End-to-end service run with mocked Confluence + GitHub APIs:
    - full space sync,
    - selected-page-only sync,
    - deletion of out-of-scope/removed pages,
    - config sync PR generation,
    - no-change idempotent rerun.
  - Failure paths: GitHub 403, Confluence 429/500, partial space failure.
- **Workflow tests**
  - execution success/failure transitions and retry behavior.

## Validation Checklist (E2E)

- Atlassian + GitHub setup remains unchanged for registration flows.
- Admin reads/writes connector config via `/config` (scope + single sync target in one request).
- Saving `/config` returns `202` and OpenWorkflow full-sync execution reaches `completed`.
- Target repo branch gets markdown files under managed root + expected deletions.
- Config update path produces config PR only when `confluence/config.yaml` changed.
- Confluence webhook event can enqueue incremental sync path using same workflow contract (even if initially gated).

## Risks and Mitigations

- **Repo/branch mismatch or missing app access**
  - Mitigation: preflight target validation endpoint + explicit 4xx with remediation.
- **Slug/path collisions**
  - Mitigation: include Confluence page ID in filename/path key.
- **Large space sync timeouts**
  - Mitigation: background workflow, pagination, per-space checkpoints, retry/backoff.
- **Over-deletion risk**
  - Mitigation: strict root-path confinement + dry-run logging in run details before deletion commit.
- **Token staleness (Forge app system token)**
  - Mitigation: rely on token-refresh webhook updates already implemented in `[apps/backend/src/routes/webhooks/atlassian/atlassian.ts](apps/backend/src/routes/webhooks/atlassian/atlassian.ts)`, fail fast if unavailable.

## Port Mapping: As-Is vs Adapt vs Drop

- **Port mostly as-is**
  - Old `converter.ts` markdown conversion core.
  - Old `config-yaml.ts` generation + "open PR on diff" semantics.
  - Old Confluence client pagination/search logic.
- **Adapt**
  - Old `sync.ts` orchestrator from `connectorId` model -> `(forgeInstallation + confluence_spaces + confluence_sync_targets)`.
  - Old GitHub write client auth from static token -> GitHub App installation token.
  - File path strategy to add collision-safe IDs.
  - Logging from `connector_sync_logs` -> OpenWorkflow + structured backend logs.
- **Drop**
  - Dependencies on `connectors`, `connector_spaces`, `connector_sync_logs`.
  - Confluence OAuth refresh/basic-auth config builder from connector config.
  - Unused `syncMode` behavior from old orchestrator and manual `POST /sync` trigger surface.

