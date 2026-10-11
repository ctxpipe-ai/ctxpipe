# Integration setup: connections authenticate, Workspace sources map

Status: approved by the CTO on 2026-10-11. Phase 1 in progress.

## Goal

- A **connection** (Connectors page) holds auth only: the OAuth grant or install, tokens, and webhooks. One connection can feed many Workspaces.
- A **Workspace source** (Workspace settings) maps a connection into one Workspace with a scope (repositories, spaces, teams, channels, pages, or services).
- The source of truth for the mapping is a **config file in the Workspace repository**. The database is a projection of that file.

## Today

- `connections` holds auth, the scope (in `config`), and one sync repository. The mirror writes into that repository. The scope config also lives there (`linear/config.yaml`, `notion/config.yaml`, and so on), and scope edits go through a PR ("awaiting merge"). Confluence uses `confluence_spaces` and `confluence_sync_targets`.
- Workspaces link GitHub repositories through `workspace_linked_repositories`.
- No record says "connection X feeds Workspace Y". The link is only implicit, through the sync repository.

## Target model

### 1. Config file in the Workspace repository

`.ctxpipe/sources.yaml`:

```yaml
version: 1
sources:
  - id: product-repos          # stable key, unique in the file
    provider: github
    connection: con_xxxxxxxx   # written by the UI; stable across renames
    repositories: [org/api, org/web]
  - id: eng-docs
    provider: confluence
    connection: con_yyyyyyyy
    spaces:
      - key: ENG
        pages: all             # or a list of page ids
  - id: eng-issues
    provider: linear
    connection: con_zzzzzzzz
    teams: [ENG]
    projects: [all]
  # slack: channels; notion: pages; pagerduty: services
```

- One shared Zod schema, used by the backend and the UI, validates the file. Each provider adds its scope shape.
- GitHub linked repositories move into this file. `workspace_linked_repositories` is retired in phase 3.

### 2. `workspace_sources`: a projection only

- Columns: `id`, `org_id`, `workspace_id`, `source_key` (the file `id`), `connection_id`, `provider`, `scope` (jsonb), `status` (`ok`, `invalid`, `connection_missing`, `out_of_access`), `status_detail`, `revision` (the Workspace revision it came from), timestamps. RLS like the neighboring tables.
- When the Workspace repository moves to a new revision, the projection updates the rows in the same way as the other Workspace projections (ADR-046). It adds, changes, or removes rows to match the file. Nothing writes rows directly.
- A bad entry (unknown connection, wrong provider, a scope out of the connection's reach, or an invalid shape) gets a row with an error status, so the settings pane can show it. The sync skips it.

### 3. Editing

- The UI (settings and wizards) edits by changing the file: a PR against the Workspace repository, or a direct commit where the Workspace allows it. This reuses the "awaiting merge" flow. Settings shows "awaiting merge" for each source.
- A manual edit of the file in git works the same, and the UI follows it.

### 4. Sync: fetch once, write for each Workspace

- For each connection, take the union of the scopes of all `ok` `workspace_sources` rows that use it. Fetch from the provider one time. Write each Workspace's part into that Workspace's repository, under the provider's managed path (the same layouts as today, for example `confluence/ENG/…`).
- A webhook arrives one time for each connection and fans out to the sources whose scope matches.
- Content commits go directly to the Workspace default branch, as mirrors do today, with one commit for each Workspace in each sync cycle. Config edits go through a PR or a direct commit, as in section 3.
- When a source is removed, the sync deletes its managed files in one commit. Git history keeps the content.
- When a connection is disconnected, its sources go to `connection_missing`. The file stays. A reconnect continues the sync.
- The per-connection sync repository is retired in phase 3.

### 5. Migration

- For each existing connection, its scope becomes an entry in `.ctxpipe/sources.yaml` of each Workspace that links its old sync repository. GitHub linked repositories also move into the file.
- Delivered as one PR for each Workspace repository. Old mirrored content stays where it is. New syncs write into the Workspace.
- A migration report lists what moved and what did not map.
- Production migrates only at deploy. Agents never touch production.

## UI

1. **Connectors page:** an expanded connector shows **Used in**: each Workspace with a base stat ("Cool workspace · 5 linked repositories", "Docs · 3 Confluence spaces"). Each item links to `/$org/ws/$slug?pane=settings#source-<provider>` and scrolls to that section. A connector with no use shows "Not used in any Workspace" and **Add to a Workspace**.
2. **Workspace settings → Sources:** one section for each source in the file, grouped by provider, with the scope summary, its status, "awaiting merge" if a change is pending, and Edit and Remove. **Add source** for each connected provider. At the bottom: **Connect another source**, which goes to the Connectors page.
3. **Wizards** (connect a new connector, or add a source): a step to select one or more Workspaces, with a shared scope or a scope for each Workspace. Closing hint: "You can add or change what each Workspace syncs at any time in its settings."

## Permissions

- Org admins connect and remove connections, as today.
- Members who can change the Workspace edit its sources. The PR flow keeps edits reviewable.

## Decisions (approved 2026-10-11)

1. One file, `.ctxpipe/sources.yaml`. It refers to connections by id.
2. The `workspace_sources` table and its migration. `workspace_linked_repositories` is retired in phase 3.
3. Content goes into each Workspace repository. When scopes overlap, each Workspace has its own copy.
4. Migration is one PR for each Workspace repository. Old content stays.
5. When a source is removed, the sync deletes its managed files in a sync commit.

## Execution

- **Phase 1A, backend foundation (one agent):** ADR; config schema and validation; `workspace_sources` with migration, projection, and RLS tests; API (list sources for a Workspace, list Workspaces for a connection with stats, edit by PR or commit); the sync frame (fetch once, write for each Workspace) and webhook fan-out; the migration framework. The first commit defines the API contract (OpenAPI and Zod types), so phase 1B can start.
- **Phase 1B, UI frame (one agent, starts when the contract commit exists):** the Used in block, the Sources section with anchors and the link to the Connectors page, the wizard Workspace step, and the hint. It uses msw fixtures from the contract.
- **Phase 2, one agent for each provider, in parallel:** GitHub, Confluence, Linear, Notion, Slack, PagerDuty. Each builds the scope schema and editor, the Used in stat, its wizard on the shared step, its sync adapter on the frame, webhook routing, the migration, tests (real Postgres, msw for the provider API), and a preview-env connector flow with the test org. PagerDuty needs the hosted OAuth app for its end-to-end test.
- **Phase 3:** retire sync repositories and `workspace_linked_repositories` after the migration is verified; public docs (`apps/docs`) and self-host notes; a changeset if `@ctxpipe/aws-cdk` changes.

Every diff gets the three-axis review (Standards, Spec, Simplicity) before merge.

## Risks

- Write fan-out: many Workspaces on one large scope give many commits for each sync. Batch one commit for each Workspace in each cycle.
- Mirror commits can race user edits on the default branch. Managed paths belong only to the mirror, so a rebase and retry resolves it.
- Storage: each Workspace has its own copy of shared content.
- The GitHub App needs write access to Workspace repositories. Git-backed Workspaces already need it.
