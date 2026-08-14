# Project Glossary

## Terms
| Term | Definition |
|------|------------|
| ctxpipe | The monorepo and product name — a code-context platform |
| Project | A context workspace in an Organisation, identified by a `proj_` id (own row, not the backing `repositories` row). It has one **backing** git repository (portable knowledge + connector mirrors) and zero or more **attached** repositories for codesearch. Display name defaults to the backing repo name, is editable, and is **git-canonical** in `AGENTS.md` front matter at the backing repo root. Cannot exist without a backing repository. Many per Organisation. Not the git repo itself, not a Linear Project, not the ingestion `project()` graph step. |
| Backing repository | The single git remote that stores a Project's git-canonical knowledge and connector mirrors. Any git URL in principle; GitHub has first-class select/create UX (GitLab and other hosts later). A URL backs at most one Project per Organisation. Implicitly included in that Project's codesearch set. Described in `AGENTS.md`; not duplicated as a self-URL under `repositories/` by default. |
| Attached repository | A git repository scoped to a Project for codesearch, in addition to the backing repository. May be a URL that another Project already backs. Declared as a markdown file under `repositories/` in the backing tree (front matter: git URL, branch, …; body: description). |
| Unlinked repository | A repository in an Organisation that is neither backing nor attached to any Project. A Project cannot exist without a backing repo; a repo can exist without a Project. |
| Path identity | The canonical identity of a git-backed knowledge unit is its path in the backing tree. A move or rename is a new identity. Serving-store ids are derived from Project + path. Knowledge rows are **Project-scoped**; codesearch indexes are **per Project** (not shared across Projects for the same git URL). |
| Confidence | Per-signal 0–1 score in the knowledge file: the **maximum** for that signal (author-stated; the knowledge skill asks the user). Hydrate copies it. **Recall** weakens it using temporality. Multiple files asserting the same edge **merge upward** with a deterministic combining rule (formula still open). |
| Temporality | Optional validity window on a claim (`valid_from` / `valid_to`; missing both = evergreen). Hydrate copies from the file. A maintenance job **fills missing `valid_from`** from the introducing git commit timestamp; bumps only when it re-asserts the claim. Recall decay uses the window when `valid_to` is set, else a source-based half-life (exact formula still open). |
| AGENTS.md (project map) | The backing repo’s root folder map: describes directories (not every unit) and holds the Project display name in front matter. Our folder-changing operations update it with a TanStack AI `chat()` agent **without** sandbox/harness. Not this monorepo’s agent-instructions `AGENTS.md`. |
| Zoekt | Google's open-source code search engine, used for indexing and searching repositories |
| MCP | Model Context Protocol — AI tool interface exposed alongside REST APIs |
| Better Auth | TypeScript authentication framework used in the backend |
| Drizzle | TypeScript ORM (beta/v1 API) for PostgreSQL |
| React Aria | Adobe's accessibility-focused React component primitives |
| TanStack Start | Full-stack React framework with file-based routing (used in apps/ui) |

## Abbreviations
| Abbrev | Expansion |
|--------|-----------|
| ADR | Architecture Decision Record |
| ORM | Object-Relational Mapping |

---
*Last updated: 2026-08-13*
