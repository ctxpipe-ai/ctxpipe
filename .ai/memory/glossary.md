# Project Glossary

## Terms
| Term | Definition |
|------|------------|
| ctxpipe | The monorepo and product name — a code-context platform |
| Project | A context workspace in an Organisation, identified by a `proj_` id (own row, not the backing `repositories` row). It has one **backing** git repository (portable knowledge + connector mirrors) and zero or more **attached** repositories for codesearch. Display name defaults to the backing repo name and may be changed. Cannot exist without a backing repository. Many per Organisation. Not the git repo itself, not a Linear Project, not the ingestion `project()` graph step. |
| Backing repository | The single git remote that stores a Project's git-canonical knowledge and connector mirrors. Any git URL in principle; GitHub has first-class select/create UX (GitLab and other hosts later). A URL backs at most one Project per Organisation. Implicitly included in that Project's codesearch set. |
| Attached repository | A git repository scoped to a Project for codesearch, in addition to the backing repository. May be a URL that another Project already backs. |
| Unlinked repository | A repository in an Organisation that is neither backing nor attached to any Project. A Project cannot exist without a backing repo; a repo can exist without a Project. |
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
