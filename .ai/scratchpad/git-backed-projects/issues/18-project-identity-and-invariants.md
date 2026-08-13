# Project identity and invariants

Type: grilling
Status: claimed

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
