# Workspace identity and invariants

Type: grilling
Status: resolved

## Question

Given [What is a Workspace](01-what-is-a-project.md) — a Context Workspace with one **workspace repository** (knowledge + connectors) and zero or more **linked** repos (codesearch) — lock identity and invariants.

Settle:

- Canonical identity: own `ws_` id, or is the Workspace the workspace repository row?
- Many Workspaces per Organisation? (nav implies yes)
- Display name: always the workspace-repository GitHub name? Two remotes can share a basename; repos can be renamed or transferred. Editable?
- Draft: can a Workspace exist before a workspace repository is linked, or is linking the create step?
- Workspace repository GitHub-only, or any git remote?
- Linked repositories: GitHub-only, or any git URL the product already allows?
- Is the workspace repository **also** linked for codesearch (search knowledge files), or only the extra repos?
- Uniqueness: can one git URL be the workspace repository for Workspace A and linked to Workspace B? Workspace repository for two Workspaces?
- Today’s ingested GitHub repos that are **not** a connector target: link them to the first Workspace, or wait for the user to link?

Recommend: own `ws_` id (relink is [Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md)); many Workspaces per org; display name defaults to workspace repository name and can diverge; no draft without a workspace repository; workspace repository is GitHub-only; linked may be any repo we can already clone; workspace repository is implicitly searchable; a git URL belongs to at most one Workspace in one role; orphan indexed repos link to the first Workspace on migration.

## Answer

Human lock, 2026-08-13:

- **Id:** `ws_` prefix (was `proj_`), own row. Not the `repositories` row.
- **Cardinality:** many Workspaces per Organisation.
- **Display name:** defaults to the workspace remote’s repo name (GitHub name when the remote is GitHub); the user may change it. A later GitHub rename does not overwrite an edited name.
- **Create:** linking (or creating) the workspace repository *is* Workspace create. A Workspace cannot exist without a workspace repository. No draft.
- **Workspace remote:** any git URL in principle. GitHub is the better UX (select from an installation, create a new repo). Other hosts (GitLab, …) are planned; they are not a special case in the aggregate — they are another remote with a thinner picker.
- **Workspace repository is searchable:** yes. It is implicitly in the Workspace’s codesearch set. Linked repositories are additional codebases.
- **Uniqueness:** a git URL is the **workspace repository of at most one** Workspace **per Organisation** (same grain as today’s `repositories.git_url` unique on org). Another Workspace may **link that same URL for search**. Two Workspaces must not both use the same URL as their workspace repository.
- **Unlinked repos:** a repository may exist in the Organisation with **no** Workspace (not a workspace repository, not linked). A Workspace may not exist without a workspace repository.
- **Today’s ingested repos that are not a connector target:** link them to the Workspace whose workspace repository is the **first connector target**. If the org has **no** connector target, they stay **unlinked**. When an existing user opens the UI with no Workspace, prompt them to create one; finishing that create **automatically links** unlinked repositories to it.

Details of “first” connector target, the OpenWorkflow job, and the prompt are [First-workspace migration and idempotent cutover](12-first-project-migration.md). Indexes stay **independent per Workspace** ([Workspace revision and derived-store freshness](11-project-revision-and-freshness.md); hydrate Q17).

## Comments

- 2026-08-13 — Recommendations on GitHub-only workspace repository and “one URL, one Workspace” were rejected. Any git URL; workspace-repository URL unique; search-import shared.
- 2026-08-13 — Close-out: glossary, map destination/decisions, and tickets 09/11/12/15 inherit these locks. Uniqueness is per Organisation, matching `repositories.git_url`.
- 2026-08-15 — Renamed Project → Workspace (`ws_`); backing → workspace repository; attached → linked.
