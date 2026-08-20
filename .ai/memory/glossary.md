# Project Glossary

## Terms
| Term | Definition |
|------|------------|
| ctxpipe | The monorepo and product name — a code-context platform |
| Workspace | The product unit — a **Context Workspace** in an Organisation, identified by a `ws_` id (own row, not the `repositories` row). One **workspace repository** (portable knowledge + connector mirrors) and zero or more **linked repositories** (codesearch). Display name defaults to the workspace-repository name, is editable, and is **git-canonical** in `AGENTS.md` front matter at that repo root. Cannot exist without a workspace repository. Many per Organisation. Not the git repo itself, not a Linear Project, not the FalkorDB `project()` verb. Formerly called Project (`proj_`). |
| Workspace slug | URL segment for a Workspace, unique per Organisation (normalised lowercase). Default is the GitHub repository name, or the last path segment of any other git URL; collisions get `-2`, `-3`. Stored on the `ws_` row, not in git. Distinct from display name and from `ws_`. Relink does not change it. |
| Workspace repository | The single git remote that *is* the Workspace’s portable source of truth (knowledge + connector mirrors). Any git URL in principle; GitHub has first-class select/create UX. A URL is the workspace repository of at most one Workspace per Organisation. Implicitly included in that Workspace’s codesearch set. Described in `AGENTS.md`; not duplicated as a self-URL under `repositories/` by default. Formerly “backing repository.” |
| Linked repository | A git repository scoped to a Workspace for codesearch, in addition to the workspace repository. May be a URL that another Workspace already uses as its workspace repository. Declared as a markdown file under `repositories/` in the workspace tree (front matter: git URL, branch, …; body: description). Formerly “attached repository.” |
| Unlinked repository | A repository in an Organisation that is neither a workspace repository nor linked to any Workspace. A Workspace cannot exist without a workspace repository; a repo can exist without a Workspace. |
| Job | Background work that **updates the workspace repository**. Many kinds: ingest, connector sync, ops/bootstrap, link/unlink, rename rewrite, claims upgrade, `valid_from` backfill, semantic rebase, UI file edit, … There is no single “the maintenance job.” Distinct from **hydrate**, which refreshes the projection and does not edit git. Product ledger is `workspace_write_jobs`; OpenWorkflow `workspace-write-commit` **runs** an attempt. |
| workspace_write_jobs | Org-scoped Postgres ledger for write **jobs** (`wjob_` id): kind, generation, desired SHA, status (including paused), payload, and commit SHA. Used for crash-after-push idempotency, pause/resume when the remote is not writable, per-kind retry caps, and relink CAS. Not an OpenWorkflow table; do not query OW internals for this state. |
| Projection | Derived retrieval state built from a workspace-repository SHA: Postgres knowledge rows, FalkorDB, Zoekt/SCIP, embeddings, and similar indexes. Intent is search/retrieval, not source of truth. If ctxpipe is off, the projection goes away; the Workspace repository remains. |
| Hydrate | Read-only (wrt git) rebuild of the **projection** from a workspace-repository tree. No extract LLM. Never writes the workspace repository. |
| Desired SHA | Stored commit we intend for a remote: workspace repository = tip of the **default branch**; linked repository = tip of front-matter `branch` (or default). Follows the remote tip, including rewind. Not a high-water mark. Always written from a **resolve** of that ref (webhook/push are triggers only — do not persist payload `after`). Distinct from the **active projection** SHA and the **indexed SHA**. |
| Indexed SHA | Codesearch checkout ready for **this Workspace** at one git URL (Zoekt+SCIP as one). Independent per Workspace; not shared when two Workspaces use the same URL. |
| Path identity | The canonical identity of a git-backed knowledge unit is its path in the workspace tree. A move or rename is a new identity. Projection ids are derived from Workspace + path. Knowledge rows and codesearch indexes are **per Workspace** (not shared across Workspaces for the same git URL). |
| Confidence | Per-signal 0–1 **maximum** in the knowledge file. Hydrate copies it into the projection. Recall decays each signal then damped-combines (`α = 0.25` in code). Skill/ingest calibrate (~0.5 typical, ~0.7 strong). |
| Temporality | Optional `[valid_from, valid_to)` window. Missing `valid_to` = evergreen (source half-life). Missing `valid_from` is derived from the introducing git commit at hydrate, then persisted by a **job**. `e = 0` before `valid_from` and at/after `valid_to`. |
| AGENTS.md (workspace map) | Workspace-repository root file: display name in front matter; **one** semantic folder-structure section the ops job maintains (any heading the user chose). Keep folders that exist; drop dead links. Not this monorepo’s agent-instructions `AGENTS.md`. |
| Read-only Workspace | A Workspace whose desired workspace remote can be cloned and hydrated, but ctxpipe cannot commit/push to it. Chrome shows read-only with an error-specific fix. **Jobs** that maintain that URL are paused; hydrate, search, and workspace chat continue. Distinct from hydrate-failed (tree unreadable). |
| Job sandbox | One long-lived TanStack sandbox per Workspace for **predefined jobs** (ingest, repair, ops, …). Concurrent jobs use **in-sandbox `git worktree`s**, not per-job sandbox forks. Distinct from a **chat sandbox** (`withSandbox` per `threadId`). Any sandbox may write, with different restrictions: jobs may push the **default branch**; chat may only open a **branch + PR**. Mechanical GitHub-API mirrors do not use it. Formerly “write sandbox.” |
| Zoekt | Google's open-source code search engine, used for indexing and searching repositories |
| MCP | Model Context Protocol — AI tool interface exposed alongside REST APIs |
| Better Auth | TypeScript authentication framework used in the backend |
| Drizzle | TypeScript ORM (beta/v1 API) for PostgreSQL |
| React Aria | Adobe's accessibility-focused React component primitives |
| TanStack Start | Full-stack React framework with file-based routing (used in apps/ui) |
| source connector | Integration that authorises an external system and makes its content available to ctxpipe. Durable connectors are **git-native** (mirror or capture into a context repository). MCP clients are not source connectors. See [source-connectors skill](../../.agents/skills/source-connectors/SKILL.md). |
| git-native | Connector pattern: write provider content as files in a **context repository**, then ingest that repo. Config lives in git yaml (via PR); Postgres holds binding and secrets only. GitHub is the current rich adapter for PRs and commits. [ADR-022](decisions/ADR-022-linear-connector-git-native-mirror.md), [ADR-023](decisions/ADR-023-notion-connector-git-native-mirror.md). |
| context repository | Git repo (often GitHub `ctxpipe-context`) that receives connector-generated files under per-connector roots (`linear/`, `notion/`, `slack/`, …). |
| Cutover | Leftover background job (`workspace-cutover`) from first-workspace migration. It auto-created a Workspace for each Linear/Notion/Confluence sync dest. **Not** a step in add-workspace. Do not enqueue it on list/tip-check; connector dests are independent of Workspace create. |
| connections.config | JSONB on the unified `connections` row: identity, encrypted secrets, and sync/capture binding. Not a per-connector table. [ADR-018](decisions/ADR-018-unified-connections-table.md). |
| deployment-owned | OAuth app + webhook URL belong to **this** ctxpipe deployment (hosted or self-host). Organisations install that app; they do not get a ctxpipe-SaaS proxy. |
| self-host data boundary | Self-hosted customer tokens, webhooks, and source bytes stay on the customer’s deployment. Hard forbid: no ctxpipe-SaaS proxy, relay, gateway, or hosted OAuth app on that path. |

## Retired names (do not use in new copy)

| Retired | Use instead |
| --- | --- |
| Project (`proj_`) | **Workspace** (`ws_`); longer copy **Context Workspace** |
| Backing repository / backing repo | **Workspace repository** |
| Attached repository / attached repo | **Linked repository** |
| Attach / detach (repos) | **Link / unlink** |
| Project chat | **Workspace chat** |
| Serving store / derived store (when you mean the index) | **Projection** |
| Write sandbox | **Job sandbox** |
| Cutover (as a product step) | **Create workspace** (GitHub picker); uniqueness = that repo already has a Workspace |

## Abbreviations
| Abbrev | Expansion |
|--------|-----------|
| ADR | Architecture Decision Record |
| ORM | Object-Relational Mapping |

---
*Last updated: 2026-08-20*
