# Project identity and invariants

Type: grilling
Status: resolved

## Question

Given [What is a Project](01-what-is-a-project.md) — a context workspace with one **backing** GitHub repo (knowledge + connectors) and zero or more **attached** repos (codesearch) — lock identity and invariants.

Settle:

- Canonical identity: own `proj_` id, or is the Project the backing repository row?
- Many Projects per Organisation? (nav implies yes)
- Display name: always the backing GitHub repo name? Two remotes can share a basename; repos can be renamed or transferred. Editable?
- Draft: can a Project exist before a backing repo is linked, or is linking the create step?
- Backing repo GitHub-only, or any git remote?
- Attached repos: GitHub-only, or any git URL the product already allows?
- Is the backing repo **also** attached for codesearch (search knowledge files), or only the extra repos?
- Uniqueness: can one git URL be backing for Project A and attached to Project B? Backing for two Projects?
- Today’s ingested GitHub repos that are **not** a connector target: attach them to the first Project, or wait for the user to attach?

Recommend: own `proj_` id (relink is [Project repository create, select, relink, and import](09-project-repository-lifecycle.md)); many Projects per org; display name defaults to backing repo name and can diverge; no draft without a backing repo; backing is GitHub-only; attached may be any repo we can already clone; backing is implicitly searchable; a git URL belongs to at most one Project in one role; orphan indexed repos attach to the first Project on migration.

## Answer

Human lock, 2026-08-13:

- **Id:** `proj_` prefix, own row. Not the backing `repositories` row.
- **Cardinality:** many Projects per Organisation.
- **Display name:** defaults to the backing remote’s repo name (GitHub name when the remote is GitHub); the user may change it. A later GitHub rename does not overwrite an edited name.
- **Create:** linking (or creating) the backing repository *is* Project create. A Project cannot exist without a backing repository. No draft.
- **Backing remote:** any git URL in principle. GitHub is the better UX (select from an installation, create a new repo). Other hosts (GitLab, …) are planned; they are not a special case in the aggregate — they are another remote with a thinner picker.
- **Backing is searchable:** yes. The backing repo is implicitly in the Project’s codesearch set. Attached repos are additional codebases.
- **Uniqueness:** a git URL **backs at most one** Project **per Organisation** (same grain as today’s `repositories.git_url` unique on org). Another Project may **import that same URL for search** (attach). Two Projects must not both *back* the same URL.
- **Unlinked repos:** a repository may exist in the Organisation with **no** Project (not backing, not attached). A Project may not exist without a backing repo.
- **Today’s ingested repos that are not a connector target:** attach them to the Project whose backing repo is the **first connector target**. If the org has **no** connector target, they stay **unlinked**. When an existing user opens the UI with no Project, prompt them to create one; finishing that create **automatically attaches** unlinked repositories to it.

Details of “first” connector target, the OpenWorkflow job, and the prompt are [First-project migration and idempotent cutover](12-first-project-migration.md). Shared attach-for-search indexing (one Zoekt clone vs many) is [Project revision and derived-store freshness](11-project-revision-and-freshness.md).

## Comments

- 2026-08-13 — Recommendations on GitHub-only backing and “one URL, one Project” were rejected. Any git URL; backing unique; search-import shared.
- 2026-08-13 — Close-out: glossary, map destination/decisions, and tickets 09/11/12/15 inherit these locks. Uniqueness is per Organisation, matching `repositories.git_url`.
