# Product Context

## Project overview

ctx| is an organization-scoped context platform for engineering teams and AI
agents. It ingests selected Git repositories and Git-backed connector content,
builds search indexes and graph claims, and exposes that context through Chat,
the knowledge graph UI, and the `ctx_advisor` MCP tool.

The monorepo uses pnpm workspaces, Turbo, and Biome. The root project is licensed
under Elastic License 2.0 by default; package-specific exceptions such as the
CLI and Confluence Forge app declare their own licenses.

## Applications and packages

- **`apps/backend`** — Hono on Bun. Owns the REST API, in-process MCP endpoint,
  Better Auth, Drizzle schema and migrations, LangGraph graphs, retrieval, and
  OpenWorkflow enqueue paths.
- **Backend worker** — the `apps/backend` OpenWorkflow worker runs durable
  repository indexing, ingestion, deletion, GitHub synchronization, and
  connector workflows.
- **`apps/codesearch`** — Hono on Bun with Zoekt, SCIP, and ast-grep. Provides
  code search, structural and symbol queries, file access, repository checkout,
  and phased indexing APIs. It authenticates backend requests with signed JWTs.
- **`apps/ui`** — TanStack Start, React, Vite, Tailwind CSS v4, React Aria, and
  Geist. Product surfaces include Chat, the knowledge graph, repositories,
  connectors, authentication, and organization settings.
- **`apps/docs`** — Fumadocs on Next.js 15. Documentation routes use the
  `/docs` base path; local docs run separately on port 3003.
- **`apps/otel-collector`** — OpenTelemetry fan-out for deployed observability.
- **`apps/forge-ctxpipe-agent`** — Atlassian Forge app for Confluence.
- **`packages/cli`** — the `ctxpipe` CLI, including `npx ctxpipe init` and local
  Markdown memory setup.
- **`packages/aws-cdk`** — AWS self-hosting construct, with a runnable example
  under `examples/aws-cdk-self-host`.

## Data and tenancy

- PostgreSQL 17 with pgvector stores application, auth, repository, connection,
  conversation, retrieval, and workflow data. All migrations live in
  `apps/backend`.
- FalkorDB is the default graph database. The graph platform supports configured
  OpenCypher providers through `GRAPH_DB_PROVIDER` and `GRAPH_DB_URI`.
- Organization DB context uses AsyncLocalStorage with
  `withSystemDbContext(...)` and `withOrgDbContext(orgId, ...)`.
- Repository IDs use the `repo_` prefix; connections use `con_`.
- Codesearch data paths are configurable and include the repository cache plus
  cold and derived hot Zoekt indexes.

## Ingestion and retrieval

- Repository and connector events enqueue durable OpenWorkflow jobs.
- `repository-ingestion` coordinates repository indexing and graph extraction.
  Its indexing child calls codesearch phases for checkout, Zoekt, language
  detection, SCIP, and SCIP merge.
- LangGraph remains responsible for code extraction and the conversation graph;
  it is not the durable workflow engine.
- The backend owns repository readiness and indexing status. Codesearch records
  checkout and indexing-step metadata.
- Retrieval combines code search, repository files, extracted objects and
  claims, graph traversal, and repository instructions.

## MCP and product interfaces

- REST routes are organization-scoped under `/:orgSlug/api/v1`.
- The product MCP is an OAuth-protected Streamable HTTP endpoint at `/mcp`.
  `ctx_advisor` is the product tool and runs the same conversation graph used by
  Chat.
- Repository explorer tools such as search, file, symbol, structural, and graph
  operations are internal agent tools; they are not separate MCP tools.
- The `ctxpipe` CLI writes MCP configuration for supported clients. Repository
  and user installation support varies by client.

## Source connectors

- Connections use the unified `connections` model with GitHub, Confluence
  (`forge`), Linear, Notion, and Slack connection types.
- GitHub repositories are selected and ingested directly.
- Linear, Notion, and Confluence mirror approved scope into a bound GitHub
  repository.
- Slack captures an existing thread after an in-thread bot mention and commits
  the snapshot to the bound repository.
- Connector content follows the repository ingestion path after it is written
  to Git.

## Local development

- `pnpm dev:infra` starts the Compose `infra` profile: PostgreSQL, FalkorDB, and
  the OpenTelemetry collector.
- `pnpm dev` runs backend and UI on the host behind portless and starts
  codesearch in Docker. Browse at `https://app.ctxpipe.localhost`.
- Linked worktrees share PostgreSQL but use one database per worktree.
- `pnpm dev:docs` runs the documentation site at `http://localhost:3003`.
- `pnpm start` runs the Compose `deploy` profile: migration, backend, worker,
  UI, and codesearch services.

## Constraints

- Backend, worker, and codesearch use Bun.
- Drizzle uses the beta/v1 API; migrations are generated and owned only by
  `apps/backend`.
- Zod schemas stay collocated with the modules they describe.
- Backend and codesearch use evlog rather than `console.*`.
- Environment variables are reserved for deployment, operator, tenant, or
  secret values.

## Non-goals

- Cloudflare Workers deployment, removed by ADR-007.
- A centralized Zod schema registry.
- Automatic ingestion of unselected developer files or entire SaaS workspaces.

---
*Last updated: 2026-08-24 by Cursor*
