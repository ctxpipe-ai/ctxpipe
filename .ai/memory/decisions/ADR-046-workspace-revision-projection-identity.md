# ADR-046: Workspace revision and projection identity

**Status:** Accepted (revised 2026-10-24) | **Date:** 2026-09-08 | **Tags:** workspace, git, postgres

## Context

What "current" meant for a Workspace was spread over loosely coupled fields (desired URL/generation/SHA, active URL/SHA, indexed SHA, hydrate status). Callers reconstructed it differently, and a queued hydrate could activate content under the wrong generation.

## Decision

- **`WorkspaceRevision`** is the one immutable identity of Workspace content: workspace id, generation, credential-free remote (URL + connection), default branch, commit SHA, and access purpose (`read` / `publish-session` / `write-default`). It is resolved at the model boundary; credentials are never part of it or of workflow input.
- **`LinkedRevision`** is the same for a linked repository: owner revision, link id, repository id, remote, ref and SHA.
- **`ProjectionState`** (`absent` / `building` / `active` / `failed`, plus `legacy` for pre-upgrade data) is the only way readers learn what is served. A building or failed replacement keeps the previous projection serving.
- **Activation** replaces knowledge units and linked membership and records the active revision in one Postgres transaction, guarded by a compare-and-set on generation, URL, connection and SHA. Relinking advances the generation; a same-SHA relink is still a new revision.
- **Derived stores** (graph, embeddings, codesearch) are keyed by the revision and report their own freshness. Failure leaves Postgres serving; they retry from Postgres without refetching git. Missing graph data is "unavailable", never an empty graph.
- **Codesearch** keeps one checkout of each repository for readers: the published checkout, at the newest commit of the default branch. Workspace code reads use it (see the revision of 2026-10-24). An ingestion run indexes its own immutable `rev:<sha>` checkout beside the published one, and only the publish step switches it. Backend-signed claims bind an ingestion run to its SHA.
- Hot paths compare stored SHAs only; git remotes are contacted by webhooks (as triggers), our pushes, hydrate/index jobs, and a periodic tip check.

## Consequences

- Queued work carries its revision and is fenced by it at activation, so late or stale work cannot publish.
- Old workflow inputs without a complete revision are rejected and re-enqueued by the tip check.
- Pre-upgrade active data is labelled `legacy` until the first successful hydrate; it is never relabelled with the current desired identity.

## Revision 2026-10-11: lost derived graph

The graph store can lose the graph of a ready revision, for example when the FalkorDB service is replaced. The graph read finds this when the completion marker or the counts do not match. The read then sets the graph phase back to `pending` with a compare-and-set, and only the caller that wins starts one hydrate run. The read answers "building" and does not build the graph itself. The hydrate run writes the revision graph again from Postgres and removes stale nodes under the revision key first.

## Revision 2026-10-15: Workspace root folder (CTX-709)

A Workspace can live in one folder of its repository, for example `docs/context` in a monorepo. The folder is `workspaces.root_path`; `""` is the repository root.

- **Identity.** A new root folder starts a new desired generation, as a relink does. `WorkspaceRevision.rootPath` carries the folder when it is not `""`. The field is absent for the repository root, so stored revisions stay equal in the SQL compare-and-set checks. The binding check needs no second comparison, because the generation changes with the folder.
- **One read path.** `workspaceRootPath()` in `domain/workspaces/root-path.ts` is the only function that reads the setting. A file in the repository can feed it later.
- **Root-relative paths.** Inside ctx|, every Workspace path is relative to the root folder: projection units, the Files pane, MCP tools, sources, write jobs, and ingestion skills. The translation happens at the Git boundary: a `GitPack` carries `root`, and the pack read and write helpers list, read, and stage only below it. The GitHub file, commit, and pull request helpers take `rootPath` the same way.
- **Server enforcement.** A path outside the root folder fails before any write: the pack and GitHub write helpers refuse it, the ingestion patch validator and assemble step refuse it (assemble also refuses symlinks and submodules), and the write-job push and the conversation push run `gitChangesOutsideWorkspaceRoot`, which also catches a write through a symlink and a new symlink that points outside. A refused conversation push answers `outside_root`. The chat agent also gets the folder in a system prompt.
- **Not changed.** One repository still backs at most one Workspace per organization (`workspaces_org_id_repository_url_uidx`). Two Workspaces in two folders of one repository need a later change to that constraint. The chat sandbox still checks out the whole repository with the repository root as its working folder.

## Revision 2026-10-15: linked pins live in the source state

The pinned ref and SHAs of each linked repository (`LinkedRevision`) move from `workspace_linked_repositories` to the `state` column of the GitHub row in `workspace_sources` ([ADR-050](ADR-050-workspace-sources-config-file.md)). The link id (`wlr_…`) stays stable. The sources projection of a revision replaces the linked membership in one transaction, right after the activation of that revision; activation itself no longer changes linked rows. The compare-and-set updates of `desiredSha` and `indexedSha` lock the source row, parse its state, check the same binding fields as before (link id, Workspace, URL, ref, SHA, owner revision, repository connection), and write the state back.

## Revision 2026-10-16: the Workspace format of a revision ([ADR-053](ADR-053-minor-upgrades-expand-only-sql-workspace-format.md))

- Hydrate reads `.ctxpipe/workspace.yaml` below the root folder, at the revision SHA, from the same pack. It records the format in the nullable cache column `workspaces.format_version`. Git stays the truth; a rebuilt database gets the value again at the next hydrate. No file means format 0.
- Two new read-only reasons use the same gate as the other write refusals (`writeJobQueueHttpDecision`):
  - `format_ahead`: the format is above the `CODE_FORMAT` of the running code (for example after a rollback). Hydrate and the read paths serve the Workspace. Every write path refuses. No upgrade is offered.
  - `format_invalid`: the file does not parse. Hydrate serves the Workspace. Every write path refuses. The UI offers a "Repair" pull request.
- The format file is host-only, as all of `.ctxpipe/` is.

## Revision 2026-10-24: Workspace code reads use the published checkout

- **Readers.** Workspace chat, the graph tools, and the MCP read surface ([ADR-051](ADR-051-mcp-read-surface.md)) read the code of each linked repository at its published checkout, which is the newest commit of the default branch. They do not read the revision SHA of the Workspace. A claim in the graph can point to code that changed after its revision. We accept this: code search shows the current code.
- **No Workspace copies.** Codesearch makes no checkout for a Workspace (no `ws:<workspaceId>:<sha>` key). The Workspace index is ready when the repository has a published checkout. One migration deletes the old Workspace rows, and a one-time codesearch cache reset deletes their files; codesearch then indexes each published revision again, with no knowledge ingestion.
- **Access.** A Workspace token lists the repositories that the Workspace links. Codesearch serves each listed repository from its published checkout, and refuses any other repository with 403. A Workspace token cannot index. An ingestion run token still reads only its own `rev:<sha>`.
- **Storage.** Each repository has one shared bare clone. Only that clone fetches, deepens, and unshallows. Each checkout key is a git worktree of the clone at the same path as before, so readers do not change. An ingestion run removes its worktree when it ends, unless it is the published checkout. Git work on one shared clone runs one operation at a time.
- **Cleanup.** The hourly cleanup also deletes files that no checkout row names, after one hour, under the purge lock of the repository. It never deletes the published checkout or a key that an unfinished run reads.
- **Why.** One pinned copy for each Workspace revision doubled the disk use and the indexing work for each commit, with no reader that needed the old code.
