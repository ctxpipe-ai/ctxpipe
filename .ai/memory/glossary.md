# Project Glossary

## Terms
| Term | Definition |
|------|------------|
| ctxpipe | Job automation that **maintains Workspaces** (git-canonical context) and serves a **projection** (retrieval index) over them. Turn ctxpipe off and the Workspace repository stays; you lose the automations and the better retrieval. |
| Workspace | The product unit — a **Context Workspace** in an Organisation, identified by a `ws_` id (own row, not the `repositories` row). One **workspace repository** (portable knowledge + connector mirrors) and zero or more **linked repositories** (codesearch). Display name defaults to the workspace-repository name, is editable, and is **git-canonical** in `AGENTS.md` front matter at that repo root. Cannot exist without a workspace repository. Many per Organisation. Not the git repo itself, not a Linear Project, not the FalkorDB `project()` verb. Formerly called Project (`proj_`). |
| Workspace repository | The single git remote that *is* the Workspace’s portable source of truth (knowledge + connector mirrors). Any git URL in principle; GitHub has first-class select/create UX. A URL is the workspace repository of at most one Workspace per Organisation. Implicitly included in that Workspace’s codesearch set. Described in `AGENTS.md`; not duplicated as a self-URL under `repositories/` by default. Formerly “backing repository.” |
| Linked repository | A git repository scoped to a Workspace for codesearch, in addition to the workspace repository. May be a URL that another Workspace already uses as its workspace repository. Declared as a markdown file under `repositories/` in the workspace tree (front matter: git URL, branch, …; body: description). Formerly “attached repository.” |
| Unlinked repository | A repository in an Organisation that is neither a workspace repository nor linked to any Workspace. A Workspace cannot exist without a workspace repository; a repo can exist without a Workspace. |
| Job | Background work that **updates the workspace repository**. Many kinds: ingest, connector sync, ops/bootstrap, link/unlink, rename rewrite, claims upgrade, `valid_from` backfill, semantic rebase, … There is no single “the maintenance job.” Distinct from **hydrate**, which refreshes the projection and does not edit git. |
| Projection | Derived retrieval state built from a workspace-repository SHA: Postgres knowledge rows, FalkorDB, Zoekt/SCIP, embeddings, and similar indexes. Intent is search/retrieval, not source of truth. If ctxpipe is off, the projection goes away; the Workspace repository remains. |
| Hydrate | Read-only (wrt git) rebuild of the **projection** from a workspace-repository tree. No extract LLM. Never writes the workspace repository. |
| Desired SHA | Stored commit we intend for a remote: workspace repository = tip of the **default branch**; linked repository = tip of front-matter `branch` (or default). Follows the remote tip, including rewind. Not a high-water mark. Written by webhook, our push, cron tip-check, or first resolve. Distinct from the **active projection** SHA and the **indexed SHA**. |
| Indexed SHA | Codesearch checkout ready for **this Workspace** at one git URL (Zoekt+SCIP as one). Independent per Workspace; not shared when two Workspaces use the same URL. |
| Path identity | The canonical identity of a git-backed knowledge unit is its path in the workspace tree. A move or rename is a new identity. Projection ids are derived from Workspace + path. Knowledge rows and codesearch indexes are **per Workspace** (not shared across Workspaces for the same git URL). |
| Confidence | Per-signal 0–1 **maximum** in the knowledge file. Hydrate copies it into the projection. Recall decays each signal then damped-combines (`α = 0.25` in code). Skill/ingest calibrate (~0.5 typical, ~0.7 strong). |
| Temporality | Optional `[valid_from, valid_to)` window. Missing `valid_to` = evergreen (source half-life). Missing `valid_from` is derived from the introducing git commit at hydrate, then persisted by a **job**. `e = 0` before `valid_from` and at/after `valid_to`. |
| AGENTS.md (workspace map) | Workspace-repository root file: display name in front matter; **one** semantic folder-structure section the ops job maintains (any heading the user chose). Keep folders that exist; drop dead links. Not this monorepo’s agent-instructions `AGENTS.md`. |
| Read-only Workspace | A Workspace whose desired workspace remote can be cloned and hydrated, but ctxpipe cannot commit/push to it. Chrome shows read-only with an error-specific fix. **Jobs** that maintain that URL are paused; hydrate, search, and workspace chat continue. Distinct from hydrate-failed (tree unreadable). |
| Write sandbox | One long-lived TanStack sandbox per Workspace for **jobs** that edit the workspace repository. Concurrent jobs use **in-sandbox `git worktree`s**, not per-job sandbox forks and not `withSandbox` per job. Distinct from a workspace-chat sandbox (`withSandbox` per `threadId`). Mechanical GitHub-API mirrors do not use it. |
| Zoekt | Google's open-source code search engine, used for indexing and searching repositories |
| MCP | Model Context Protocol — AI tool interface exposed alongside REST APIs |
| Better Auth | TypeScript authentication framework used in the backend |
| Drizzle | TypeScript ORM (beta/v1 API) for PostgreSQL |
| React Aria | Adobe's accessibility-focused React component primitives |
| TanStack Start | Full-stack React framework with file-based routing (used in apps/ui) |

## Retired names (do not use in new copy)

| Retired | Use instead |
| --- | --- |
| Project (`proj_`) | **Workspace** (`ws_`); longer copy **Context Workspace** |
| Backing repository / backing repo | **Workspace repository** |
| Attached repository / attached repo | **Linked repository** |
| Attach / detach (repos) | **Link / unlink** |
| Project chat | **Workspace chat** |
| Serving store / derived store (when you mean the index) | **Projection** |

## Abbreviations
| Abbrev | Expansion |
|--------|-----------|
| ADR | Architecture Decision Record |
| ORM | Object-Relational Mapping |

---
*Last updated: 2026-08-15*
