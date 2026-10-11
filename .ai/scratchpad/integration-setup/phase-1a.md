Contract commit: 067ed818 (branch is-foundation). Contract change in 65d1789e: a direct commit returns `{ outcome: "commit_queued", sourceKey }` (no SHA).

# Phase 1A: backend foundation

Plan: [plan.md](plan.md).

## Contract (for phase 1B)

- Shared schema of `.ctxpipe/sources.yaml`: `apps/backend/src/domain/workspace-sources/sources-file.ts`. The UI imports it as `backend/domain/workspace-sources/sources-file` (tsconfig path alias). It imports only `zod`.
- Provider scope modules: `apps/backend/src/domain/workspace-sources/providers/<provider>.ts`. Each phase 2 agent replaces its placeholder with a scope schema and a `summarize` function.
- Routes and response types: `apps/backend/src/routes/v1/workspace-sources-contract.ts`. The `hc` client infers them:
  - `GET  /:orgSlug/api/v1/workspaces/:workspaceSlug/sources`
  - `POST /:orgSlug/api/v1/workspaces/:workspaceSlug/sources`
  - `PUT  /:orgSlug/api/v1/workspaces/:workspaceSlug/sources/:sourceKey`
  - `DELETE /:orgSlug/api/v1/workspaces/:workspaceSlug/sources/:sourceKey?delivery=`
  - `GET  /:orgSlug/api/v1/connectors/:connectionId/workspaces`
- A change returns `{ outcome: "pull_request", pullRequestUrl }` (awaiting merge) or `{ outcome: "commit_queued" }` (the Workspace write queue commits it).
- Pending PRs come back in `pendingChanges` (join on `sourceKey`). Their branch is `ctxpipe/sources/<action>/<provider>/<key>-<ms>`.
- `connectionName` is null for now (connections have no display name).

## Steps

1. Contract: done (067ed818).
2. ADR: done (ADR-050).
3. `workspace_sources` table, migration, model, RLS tests: done.
4. Projection: done (hydrate step `project-workspace-sources`).
5. Edit API: done.
6. Sync frame and webhook fan-out: to do.
7. Migration framework: to do.
