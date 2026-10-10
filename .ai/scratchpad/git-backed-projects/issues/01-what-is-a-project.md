# What is a Workspace

Type: grilling
Status: resolved

## Question

What is a **Workspace** (Context Workspace) in ctxpipe — domain concept, identity, and aggregate? (Grilled as “Project”; renamed 2026-08-15.)

Today an Organisation has many `repositories` (git URL, often GitHub, with `github_connection_id`). Connectors bind to one of those repositories and mirror content into it. There is no Workspace table. Chat and the knowledge graph are organisation-wide.

The brief says a Workspace is linked to **one GitHub repository**; integrations group by the repository they already bind to; that repository **becomes** the Workspace; the Workspace **name** is the repository name; codesearch repositories are **scoped to Workspaces**; the UI is a list of Workspaces.

Those statements still allow two aggregates. Do not collapse them by assumption:

1. **Workspace is that GitHub repo.** Every ingested GitHub repository becomes its own Workspace. Knowledge files live in the same repo. Codesearch indexes that repo.
2. **Workspace is a Context Workspace** with one **workspace repository** for knowledge + connectors, and zero or more **linked** repos for codesearch.

Settle:

- Canonical identity: own `ws_` id, or the repository row?
- Many Workspaces per Organisation? (nav implies yes)
- Display name: always the GitHub repo name? Two remotes can share a basename; repos can be renamed or transferred.
- Valid lifecycle states: can a Workspace exist before a repo is linked (draft), or is linking the create step?
- GitHub-only, or any git remote?
- What happens to GitHub repos that are indexed today but are **not** a connector target?

Recommend the smallest aggregate that still matches "portable context in one git repo" and "codesearch scoped to Workspaces."

## Answer

**A Workspace is a Context Workspace with one workspace repository for knowledge + connectors, and zero or more linked repositories for codesearch.**

It is not “one git repo = one Workspace.” Knowledge files and connector mirrors live only in the **workspace repository**. Codesearch/source repos are **linked** to the Workspace and may be many or none.

Human lock, 2026-08-13. Identity (`ws_`), naming, no-draft, any-git-with-GitHub-UX, uniqueness, and unlinked repos are [Workspace identity and invariants](18-project-identity-and-invariants.md).

## Comments

- 2026-08-13 — Option 2 accepted verbatim. Option 1 (Workspace is the GitHub repo) is rejected.
- 2026-08-15 — Renamed Project → Workspace; backing → workspace repository; attached → linked. Id prefix `proj_` → `ws_`.
- 2026-08-13 — [Workspace identity and invariants](18-project-identity-and-invariants.md) refined “GitHub repo” to **any git URL**, with GitHub as the first-class select/create UX.
