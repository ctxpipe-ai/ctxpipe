# What is a Project

Type: grilling
Status: resolved

## Question

What is a **Project** in ctxpipe — domain concept, identity, and aggregate?

Today an Organisation has many `repositories` (git URL, often GitHub, with `github_connection_id`). Connectors bind to one of those repositories and mirror content into it. There is no Project table. Chat and the knowledge graph are organisation-wide.

The brief says a Project is linked to **one GitHub repository**; integrations group by the repository they already bind to; that repository **becomes** the Project; the Project **name** is the repository name; codesearch repositories are **scoped to Projects**; the UI is a list of Projects.

Those statements still allow two aggregates. Do not collapse them by assumption:

1. **Project is that GitHub repo.** Every ingested GitHub repository becomes its own Project. Knowledge files live in the same repo. Codesearch indexes that repo.
2. **Project is a context workspace** with one **backing** GitHub repo for knowledge + connectors, and zero or more **attached** repos for codesearch.

Settle:

- Canonical identity: own `proj_` id, or the repository row?
- Many Projects per Organisation? (nav implies yes)
- Display name: always the GitHub repo name? Two remotes can share a basename; repos can be renamed or transferred.
- Valid lifecycle states: can a Project exist before a repo is linked (draft), or is linking the create step?
- GitHub-only, or any git remote?
- What happens to GitHub repos that are indexed today but are **not** a connector target?

Recommend the smallest aggregate that still matches "portable context in one git repo" and "codesearch scoped to projects."

## Answer

**A Project is a context workspace with one backing GitHub repo for knowledge + connectors, and zero or more attached repos for codesearch.**

It is not “one GitHub repo = one Project.” Knowledge files and connector mirrors live only in the **backing** repository. Codesearch/source repos are **attached** to the Project and may be many or none.

Human lock, 2026-08-13.

Identity, naming, draft-before-link, GitHub-only, and what to do with today’s indexed repos that are not a connector target are **not** this answer — they are [Project identity and invariants](18-project-identity-and-invariants.md).

## Comments

- 2026-08-13 — Option 2 accepted verbatim. Option 1 (Project is the GitHub repo) is rejected.
