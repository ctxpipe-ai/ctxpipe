# Project Glossary

## Terms
| Term | Definition |
|------|------------|
| ctxpipe | The monorepo and product name — a code-context platform |
| Project | A context workspace in an Organisation. It has one **backing** GitHub repository (portable knowledge + connector mirrors) and zero or more **attached** repositories for codesearch. Not the GitHub repo itself, not a Linear Project, not the ingestion `project()` graph step. |
| Backing repository | The single GitHub repository that stores a Project's git-canonical knowledge and connector mirrors. |
| Attached repository | A git repository scoped to a Project for codesearch, distinct from the backing repository. |
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
