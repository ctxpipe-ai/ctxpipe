# ADR-050: Workspace sources as node files; connections hold auth only

**Status:** Accepted (revised 2026-10-16) | **Date:** 2026-10-11 | **Tags:** connectors, workspaces, git, postgres, multi-tenant

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

## Revision 2026-10-16: each source is a Markdown node file under `sources/` (CTX-721)

### Context

`.ctxpipe/sources.yaml` holds all sources of a Workspace in one YAML file. A source is not a node of the graph. An agent that walks the files cannot see what a source is for, and a unit cannot link to the source that it came from. Ingestion v2 ([ADR-052](ADR-052-ingestion-sandbox-skills-patches.md)) records provenance as source URLs in the `sources` front matter, which only GitHub sources have. Before ADR-050, a linked repository was a Markdown file (`repositories/*.md`), so it was a file that people and agents could read.

### Decision

1. **One file for each source.** Each Workspace source is one Markdown file under `sources/`, below the Workspace root folder (CTX-709). The front matter holds the structured source: provider, connection, and scope. The body is an optional short description of what the source is for. The body must not repeat the front matter. People own the body; ctx| never changes it.
2. **The path is the identity.** Data refers to a source by its path, relative to the Workspace root folder (for example `sources/github/acme/checkout-api.md`). There is no `id` key. `workspace_sources.source_key` holds the path.
3. **Path rules.** A source path is `sources/<provider>/<name>.md` or `sources/<provider>/<group>/<name>.md`. `<provider>` must be the `provider` of the front matter. Each other segment matches `[a-z0-9][a-z0-9._-]{0,99}`. ctx| names a new file as follows:
   - GitHub: `sources/github/<owner>/<name>.md` (lowercase). One file for each repository.
   - Other providers: `sources/<provider>/<name>.md`. `<name>` comes from the label that the user gives, or the provider name with a free suffix (`linear`, `linear-2`).
   A person can rename or move a file inside these rules. A file under `sources/` that breaks the rules gets an `invalid` row with the reason.
4. **One GitHub repository for each file.** A GitHub source names one repository and an optional `ref`. Thus provenance is for one repository, and each file holds one pin.
5. **Projection.** `workspace_sources` is a projection of the files under `sources/` at the Workspace revision. Each file gives one row. A file that does not parse, or that has a bad shape, gives an `invalid` row keyed by its path. A file larger than 64 KiB, or a file that is not text, gives an `invalid` row too; ctx| does not read it into memory. The reserved `.file` row goes away with the YAML read (decision 15). The `connection_missing` and `out_of_access` rules do not change.
6. **Rules across files.** The projection checks all files together, after it checks each file:
   - Two GitHub sources that name the same repository (case-insensitive, after URL normalization). A source file names one repository, so a file that loses becomes `invalid`. A YAML entry (decision 15) can name many repositories, so it does not become `invalid`: it stays `ok`, skips only the repository that another source holds, and its detail names that repository and the source that links it. Of two YAML entries, the earlier entry in the file links the repository, as before. Pins and the hydrate linked set give each repository first to the source file that holds it, then to the YAML entries in file order.
   - A GitHub source file that names the Workspace repository. (A YAML entry only skips that repository; see decision 15.)
   - Two `ok` sources whose managed paths overlap (the `managedPaths` of the provider adapter: one path is equal to, or below, the other).
   A row holds its repositories and managed paths while its status is `ok`, `out_of_access`, or `connection_missing`. Only a row that holds takes part in these rules. The row that held at the previous projected revision keeps the hold. When a holding row goes away and a new path holds the same repository or managed path (a rename), the new path keeps the hold. When no row held before, the first path in byte order gets the hold. Each other row becomes `invalid`, and its detail names the path that it conflicts with. Thus a new file can never take the place of a source that already syncs, also while that source has no access or no connection for a time. The hydrate linked set and the GitHub mirror scope check use the same function as the projection, so they get the same winner.
7. **Pins.** `workspace_sources.state` stays, keyed by the source path. A GitHub row keeps the shape `{ provider: "github", repositories: [pin] }` with exactly one pin. The projection keeps the `wlr_…` id and the SHAs while the repository URL and `ref` do not change, also when the file has a new path. Thus a rename keeps the pin with no rename detection. `linkId`, `LinkedRevision`, and `DELETE /linked-repositories/{linkedId}` do not change.
8. **Provenance on units.** Each unit that ctx| writes from a source has the host-set front matter `sources`: a list of source paths (relative to the Workspace root folder). Ingestion v2, each connector mirror writer (Linear, Notion, Slack, PagerDuty, Confluence), and the GitHub pull request mirror write it. A mirror file lists exactly one source. The `sources` list of ADR-052 holds source paths, not source URLs, from this revision.
9. **Graph.** Hydrate projects each source file as a unit of kind `Source`. It projects each path in the `sources` list of a unit as an edge `FROM_SOURCE` from the unit to the `Source` unit, with confidence 1. A path that is not a source file makes no edge. The default walks of `get_related` do not follow `FROM_SOURCE`: not the walk of an intent, and not the walk of all edges (also not the fallback walk). Only the new intent `provenance`, or explicit `predicates` that name `FROM_SOURCE`, walk it.
10. **Trust boundary.** A source grants data flow: a connection and a scope. Thus no agent can change `sources/` without a pull request that a person merges. The shared host-only path list (`apps/backend/src/domain/workspaces/host-only.ts`, CTX-722) holds `.ctxpipe/` and `sources/`, and every agent write path uses it:
    - Host writers: the source edit service (API and UI), link and unlink, the conversion, and the rename rewrite.
    - People: a push to the Workspace repository, a merged pull request, and the Files pane edit of a signed-in user.
    - The writers that change the Workspace with no pull request refuse each path under `sources/` (`host_only_path`): the patch validator, the ingest ref broker, and the semantic merge. Each MCP write tool that writes with no pull request refuses it too.
    - Conversation publish allows a change under `sources/`. It pushes only the session branch, and a person reviews and merges the pull request. Thus an agent can propose a source change, but it cannot apply one.
    - An agent write can remove a path from the `sources` list of a unit, or remove `generated_by`, because that gives control of the file to people. It cannot add a path to `sources`, or add or change `generated_by`, because that gives ingestion control of a file that a person owns. This ownership-field guard applies to every agent write, also conversation publish. The patch validator stamps these fields itself (ADR-052 section 2).
    - A person with write access to the Workspace repository is trusted, as for every other file. The projection checks the connection and the scope access, so a source file cannot reach data outside the org's connections.
11. **Renames.** A rename that the host makes (the edit service) moves the file and changes the `sources` list of each unit that names the old path, in the same commit. A rename that a person makes in git gets the same change in a follow-up commit from the rename rewrite of hydrate. The next sync of each connector writes the new path into the mirror files, because the mirror owns them.
12. **Edits.** Add, edit, rename, and remove change one file under `sources/`. Link adds `sources/github/<owner>/<name>.md`. Unlink deletes the file of that repository. Delivery stays a pull request or a direct commit.
13. **Mirror fence.** A connector mirror commit is fenced by the git tree id of `sources/` at the projected revision, not by the blob of `.ctxpipe/sources.yaml`. While both inputs exist (decision 15), the fence is a hash of the blob id of `.ctxpipe/sources.yaml` and the tree id of `sources/`. When only one exists, the fence is the id of that one.
14. **Conversion.** One explicit conversion turns `.ctxpipe/sources.yaml` and each `repositories/*.md` file of a Workspace into files under `sources/`, and changes the `sources` lists of units from source URLs to source paths. It makes one commit for each Workspace and is idempotent. The link and unlink edit also converts the Workspace first, as the 2026-10-15 upgrade did.
15. **Dual read until the conversion is done.** Until the conversion report shows that each Workspace converted, the projection reads `.ctxpipe/sources.yaml` and the files under `sources/` together. A YAML entry keeps its old key and gives a row as before. The rules across files (decision 6) apply to the rows of both inputs. A YAML entry that names the Workspace repository, or a repository that another source holds, stays `ok` and links only its other repositories, as before (decision 6). A file-level error of `.ctxpipe/sources.yaml` gives the reserved `.file` row until T11. The mirror fence covers both inputs (decision 13). One function holds the YAML read, so a later change (T11) can remove it.
16. **Agent proposals.** A chat tool that proposes a new source is out of scope of this revision. An agent can still propose a source file through conversation publish (decision 10).

### File schema

Common front matter keys of every source file:

| Key | Type | Rule |
| --- | --- | --- |
| `provider` | `github` \| `confluence` \| `linear` \| `notion` \| `slack` \| `pagerduty` | Required. Equal to the provider folder of the path. |
| `connection` | string `con_…` | Required. A connection of the org, of the type of the provider. |
| scope keys | see below | The other keys. The scope schema of the provider is strict: an unknown key makes the row `invalid`. |

`id` and `kind` are not allowed: the path is the id, and the folder gives the kind. The whole file is at most 64 KiB. The body is free Markdown. The projection does not read it.

**GitHub** (`sources/github/<owner>/<name>.md`)

| Key | Type | Rule |
| --- | --- | --- |
| `repository` | string `owner/name` | Required. A GitHub repository that the connection can read. |
| `ref` | string | Optional. A branch or tag that git accepts in a fetch. Without it, ctx| reads the default branch. |

```markdown
---
provider: github
connection: con_7Hq2xVn4
repository: acme/checkout-api
ref: release
---

The payment API. Use it for questions about checkout, refunds, and card tokens.
```

**Linear** (`sources/linear/<name>.md`): `teams` (list of team keys), `projects` (list of project ids), `customerRequests` (`exclude` \| `limited`). At least one team or project.

```markdown
---
provider: linear
connection: con_Lr81kQe0
teams: [ENG, OPS]
customerRequests: exclude
---

Engineering and operations work. Customer requests stay in the support Workspace.
```

**Notion** (`sources/notion/<name>.md`): `pages` and `databases`, each a list of `{ id, title }`. At least one page or database.

```markdown
---
provider: notion
connection: con_Nt3pW9za
pages:
  - id: 1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9
    title: Engineering handbook
databases:
  - id: 0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e
    title: Runbooks
---
```

**Slack** (`sources/slack/<name>.md`): `channels` (list of channel ids, at least one).

```markdown
---
provider: slack
connection: con_Sk5mRt2b
channels: [C0123ABCD, C0456EFGH]
---

Incident and release channels.
```

**PagerDuty** (`sources/pagerduty/<name>.md`): `services` (list of service ids, at least one).

```markdown
---
provider: pagerduty
connection: con_Pd9cXy1u
services: [PSVC001, PSVC002]
---
```

**Confluence** (`sources/confluence/<name>.md`): `spaces` (list of `{ key, pages }`, where `pages` is `all` or a list of page ids).

```markdown
---
provider: confluence
connection: con_Cf4hJk8s
spaces:
  - key: ARCH
    pages: all
  - key: OPS
    pages: ["12345", "67890"]
---
```

### Unit `sources` field

```yaml
sources:
  - sources/github/acme/checkout-api.md
```

- A list of strings. Each string is a source path relative to the Workspace root folder: no leading `/`, `./`, or `../`.
- The list is unique and in byte order.
- Only the host writes it (ingestion v2 stamp, mirror writers, conversion, rename rewrite). An agent can only remove values.
- A mirror file lists exactly one path. A shared ingestion file (for example an instruction area) can list many.
- A file is owned by a source when it has `generated_by: ctxpipe-extract` and its `sources` list holds the path of that source (ADR-052 section 3).
- This field is not the mirror field `source: <provider>`. That field stays.

### Graph names

| Name | Value |
| --- | --- |
| Node kind | `Source` (folder `sources/`) |
| Edge predicate | `FROM_SOURCE` (unit → `Source`) |
| Intent | `provenance`: walks `FROM_SOURCE` and the link edges |
| Default walks | Every other intent, the walk of all edges, and the fallback walk exclude `FROM_SOURCE` |

### Supersedes

- Decision 2 (`.ctxpipe/sources.yaml`, `version: 1`, entries with `id`) and decision 4 (edits change "the file") of this ADR.
- The revisions 2026-10-14 and 2026-10-15 where they name `.ctxpipe/sources.yaml`, the GitHub entry `linked-repositories`, or a list of repositories in one GitHub entry. The pins in `workspace_sources.state` stay.
- In [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md): "a GitHub entry in `.ctxpipe/sources.yaml`" becomes "a GitHub source file", and `sources` holds source paths, not source URLs.
- The `.file` row of the projection.

### Consequences

- Each source is a node that people and agents can read, and each unit links to its sources. `get_related` can answer "where did this come from" and "what came from this source".
- A `Source` node with many units is a hub. The default walks skip its edge, so it does not hide the owner or the decisions of a unit. The relevance eval proves this.
- A rename of a source changes the `sources` list of each unit that names it. For a large mirror, the next sync makes a large commit.
- The trust boundary has more places to guard: the patch validator, conversation publish, and MCP write tools.
- Rules across files (duplicate and overlap) move from the YAML schema to the projection.
- The API key of a source is a path with `/`. The routes take it in the body or a query parameter.

## Revision 2026-10-16: the migration is upgrade format 1 ([ADR-053](ADR-053-minor-upgrades-expand-only-sql-workspace-format.md))

- **Decision 6 and the revision 2026-10-14 change.** The migration of connection scopes and org repositories is not a command any more. It is git upgrade step 1 of the upgrade registry. Step 1 writes the sources of each Workspace (the org repositories, the GitHub `repositories/*.md` files and the connection scopes), deletes the GitHub `repositories/*.md` files, and moves old connector files to their managed paths. It exports only the knowledge that fresh ingestion cannot rebuild ([ADR-053](ADR-053-minor-upgrades-expand-only-sql-workspace-format.md) section 5). It goes into the upgrade pull request (branch `ctxpipe/upgrade/format-<target>`), never into a direct push to the default branch. The commit of step 1 sets `format: 1` in `.ctxpipe/workspace.yaml`. An operator click opens the pull request, also on hosted. No code path queues the `migration_export` write kind any more, and the tip check does not resume an old paused one. Its workflow name stays one minor release as a retired stub. `migrateWorkspaceSources.ts` is a thin wrapper: without `--apply` it prints the source plan, and with `--apply` it starts the Workspace upgrade, as the "Open upgrade PR" button does (CTX-743).
- **Decision 14 (conversion)** is git upgrade step 2. Its commit sets `format: 2`.
- **No write access.** A Workspace with no write access shows the upgrade state `blocked: write_access`. The 1-minute retry of the old export goes away. A click on "Check write access" retries one time.
- **Legacy handover for every provider (CTX-737).** Before this revision, only the Notion and PagerDuty bindings handed over. Now `legacyBindingHandedOver` covers every legacy connector binding: Linear, Slack, Confluence, Notion and PagerDuty. A legacy sync stops when an `ok` Workspace source of the same connection owns its target. Confluence matches by the connection, not by the repository. Thus no connector writes the same content to the old sync repository and to the Workspace. This is the phase 1 gate of [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md).
- **Writers check the format.** A source config edit on a Workspace below format 2 refuses with "Upgrade this Workspace first". The dual read of decision 15 stays until the next major.
