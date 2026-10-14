# ADR-050: Workspace sources in a config file; connections hold auth only

**Status:** Accepted | **Date:** 2026-10-11 | **Tags:** connectors, workspaces, git, postgres, multi-tenant

## Context

A connection (`connections` row, [ADR-018](ADR-018-unified-connections-table.md)) holds the auth grant, the scope, and one sync repository. The mirror writes into that repository, and the scope file lives there too (`linear/config.yaml`, `notion/config.yaml`, `pagerduty/config.yaml`, and the Confluence scope PR). Workspaces link repositories through `workspace_linked_repositories`. No record says "connection X feeds Workspace Y". The link is only implicit, through the sync repository. One connection cannot feed many Workspaces with different scopes.

## Decision

1. **A connection holds auth only:** the OAuth grant or install, tokens, and webhooks. Org admins connect and remove connections.
2. **A Workspace source maps a connection into one Workspace with a scope.** The source of truth is `.ctxpipe/sources.yaml` in the Workspace repository (`version: 1`, a list of entries with `id`, `provider`, `connection`, and a provider scope). One shared Zod schema (`apps/backend/src/domain/workspace-sources/sources-file.ts`) validates it for the backend and the UI. Each provider adds its scope shape in its own module.
3. **`workspace_sources` is a projection of that file.** When the Workspace revision changes ([ADR-046](ADR-046-workspace-revision-projection-identity.md)), the projection adds, changes, or removes rows to match the file, and records the revision. Nothing else writes rows. A bad entry (unknown connection, wrong provider, scope out of reach, invalid shape) gets a row with an error status; the sync skips it. A disconnected connection makes its sources `connection_missing`; the file stays.
4. **Edits change the file:** a PR against the Workspace repository ("awaiting merge"), or a direct commit when the default branch accepts it. A manual edit in git has the same effect.
5. **Sync fetches once for each connection and writes for each Workspace.** It takes the union of the `ok` scopes of the connection, calls the provider adapter one time, and writes each Workspace's slice under the provider's managed path, with one commit for each Workspace in each cycle. A webhook arrives once for each connection and fans out to the matching sources. A removed source has its managed files deleted in a sync commit. Overlapping scopes give each Workspace its own copy.
6. **Migration** turns the scope of each existing connection into entries of each Workspace that links its old sync repository, and moves GitHub linked repositories into the file. It makes one PR for each Workspace repository and a report. It runs only by an explicit command, never at boot.

## Supersedes

- The per-connection sync repository (`connections.config` `repositoryId` / `branch` / `enabled`) and the in-repository scope files (`<provider>/config.yaml`, `pendingConfigPullUrl`) in [ADR-022](ADR-022-linear-connector-git-native-mirror.md), [ADR-023](ADR-023-notion-connector-git-native-mirror.md), [ADR-025](ADR-025-slack-connector-git-native-mirror.md) (sync target), [ADR-031](ADR-031-github-pr-scoped-mirror.md) (scope source), and [ADR-034](ADR-034-pagerduty-connector-git-native-mirror.md). Phase 3 removes them after the migration is verified.
- In [ADR-018](ADR-018-unified-connections-table.md), `connections.config` no longer holds scope or a sync target. The table stays.
- [ADR-028](ADR-028-git-native-connector-assets.md) asset rules apply unchanged, inside each Workspace's managed path.
- `workspace_linked_repositories` and the `repositories/*.md` link files. GitHub sources in the file replace both; the pins live in `workspace_sources.state` (revision 2026-10-15).

## Consequences

- One connection feeds many Workspaces, each with its own reviewable scope.
- Write fan-out: many Workspaces on one large scope give more commits; the one-commit-per-Workspace-per-cycle rule limits it.
- Mirror commits can race user edits on the default branch. Managed paths belong only to the mirror, so a rebase and retry resolves it.
- Storage grows with overlap, because each Workspace keeps its own copy.
- The GitHub App needs write access to each Workspace repository, as git-backed Workspaces already do.

## Revision 2026-10-14: upgrade from the repository list

On `main`, the org `repositories` table holds the linked repositories of an organization. The SQL backfill that makes the first Workspaces no longer copies them into `workspace_linked_repositories`. The knowledge export of the first Workspace of the org (`org_first_workspaces`) reads that table and adds each other GitHub repository to the GitHub source `linked-repositories` in `.ctxpipe/sources.yaml`, with the Workspace's GitHub connection. It writes no `repositories/*.md` file. A repository that a GitHub source of the file already links is not added again, so a second export changes nothing. A repository that is not on GitHub is not linked.

## Revision 2026-10-15: `sources.yaml` is the only link; pins in `workspace_sources.state`

- `.ctxpipe/sources.yaml` is the only place that links a repository to a Workspace. ctx| does not read or write `repositories/*.md` files any more. Link and unlink (the API, the UI, and the `workspace-write-link-unlink` workflow) edit the GitHub source entry of the file through the Workspace commit path. Link adds the repository to a GitHub entry of the Workspace's GitHub connection, or makes the entry `linked-repositories` when there is none. Unlink removes the repository from each GitHub entry, and removes an entry that has no repository left.
- An item of the GitHub scope `repositories` is `owner/name` or a map `{ name: owner/name, ref: <branch or tag> }`. Without `ref`, ctx| reads the default branch of the repository. A repository that is not on GitHub cannot be linked.
- The pinned state of a source is in the `state` JSONB column of its `workspace_sources` row. A Zod union on the provider types it. For GitHub it holds, for each repository, `{ id: "wlr_…", gitUrl, ref, desiredSha, indexedSha, createdAt }`. The `wlr_…` id stays stable while the repository and its `ref` stay in the file, so `linkId`, `LinkedRevision`, and `DELETE /linked-repositories/{linkedId}` do not change. One module (`apps/backend/src/models/workspace-source-state.ts`) reads and writes the column. An invalid shape is read as empty and logged; it never stops hydrate. JSONB, not a table, because each provider can add its own pointers (for example a cursor) without a new table, and the state always belongs to exactly one source row.
- The sources projection writes the state. It keeps the id and the SHAs of a repository whose URL and `ref` do not change, gives a new id to a new repository or a changed `ref`, and drops a removed repository. A repository that an earlier GitHub entry or the Workspace repository already names is not linked again.
- `workspace_linked_repositories` is removed. It was only in this branch, so its branch migrations no longer make it.
- The knowledge export of the upgrade also turns the existing `repositories/*.md` files of a Workspace repository into entries of the GitHub source `linked-repositories`, with their `branch` as `ref`, and deletes those files in the same commit.
