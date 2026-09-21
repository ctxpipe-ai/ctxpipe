# Project Glossary

## Terms
| Term | Definition |
|------|------------|
| ctxpipe | The monorepo and product name — a code-context platform |
| Zoekt | Google's open-source code search engine, used for indexing and searching repositories |
| MCP | Model Context Protocol — AI tool interface exposed alongside REST APIs |
| Better Auth | TypeScript authentication framework used in the backend |
| Drizzle | TypeScript ORM (beta/v1 API) for PostgreSQL |
| React Aria | Adobe's accessibility-focused React component primitives |
| TanStack Start | Full-stack React framework with file-based routing (used in apps/ui) |
| source connector | Integration that authorises an external system and makes its content available to ctxpipe. Durable connectors are **git-native** (mirror or capture into a context repository). MCP clients are not source connectors. See [source-connectors skill](../../.agents/skills/source-connectors/SKILL.md). |
| git-native | Connector pattern: write provider content as files in a **context repository**, then ingest that repo. Config lives in git yaml (via PR); Postgres holds binding and secrets only. GitHub is the current rich adapter for PRs and commits. [ADR-022](decisions/ADR-022-linear-connector-git-native-mirror.md), [ADR-023](decisions/ADR-023-notion-connector-git-native-mirror.md). |
| context repository | Git repo (often GitHub `ctxpipe-context`) that receives connector-generated files under per-connector roots (`linear/`, `notion/`, `slack/`, `github/`, …). |
| connections.config | JSONB on the unified `connections` row: identity, encrypted secrets, and sync/capture binding. Not a per-connector table. [ADR-018](decisions/ADR-018-unified-connections-table.md). |
| deployment-owned | OAuth app + webhook URL belong to **this** ctxpipe deployment (hosted or self-host). Organisations install that app; they do not get a ctxpipe-SaaS proxy. |
| self-host data boundary | Self-hosted customer tokens, webhooks, and source bytes stay on the customer’s deployment. Hard forbid: no ctxpipe-SaaS proxy, relay, gateway, or hosted OAuth app on that path. |
| File (graph) | Location node for a repo-relative path (`fil:${repositoryId}:${path}`). Not a document kind. Join for `DECLARED_IN` (instruction units, decisions), pull-request change edges, and `PART_OF` containment. [ADR-032](decisions/ADR-032-path-located-graph-edges.md), [ADR-033](decisions/ADR-033-graph-ontology-v2.md). |
| relation family | Group of graph predicates with one semantics: containment (`PART_OF`), provenance (`DECLARED_IN`), change (`TARGETS`, `ADDED`…), reference (`REFERENCES`, `MENTIONS`, `SUPERSEDES`), ownership (`OWNS`), cause (`INFLUENCES`). [ADR-033](decisions/ADR-033-graph-ontology-v2.md). |
| reference resolver | `domain/codeIngestion/referenceResolver.ts`: the single mapping from provider URLs, identifiers and repo paths to graph keys, shared by every extractor so the same real thing gets one node. |
| join density | Graph health metric: share of objects whose claims carry evidence from ≥2 extractors. Replaces nodes-to-edges as the north star. `GET /:orgSlug/api/v1/knowledge-graph/quality`. |

## Abbreviations
| Abbrev | Expansion |
|--------|-----------|
| ADR | Architecture Decision Record |
| ORM | Object-Relational Mapping |

---
*Last updated: 2026-09-17*
