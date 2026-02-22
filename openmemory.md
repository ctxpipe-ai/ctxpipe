# ctxpipe – Project index

## Overview

Monorepo for **ctxpipe**, managed with pnpm workspaces and Turbo. Apps live in `apps/`, shared packages in `packages/`.

## Architecture

- **Backend** (`apps/backend`): Hono-based service exposing REST API and MCP (via `@hono/mcp`), with LangChain/LangGraph for agent workflows (graphs in src/graphs/, model factory in src/config/models.ts). Deployable to Bun-based containers. Uses Drizzle + PostgreSQL, Better Auth (scaffolded), Zod (collocated), OpenRouter for LLM. Owns `repositories` table and all migrations. See [apps/backend/adr/0001-backend-service-stack-and-runtime.md](apps/backend/adr/0001-backend-service-stack-and-runtime.md), [apps/backend/adr/0004-langgraph-integration.md](apps/backend/adr/0004-langgraph-integration.md).
- **Codesearch** (`apps/codesearch`): Bun service that orchestrates Zoekt (search proxy, on-demand indexing, file serving). Read-only access to Postgres `repositories`; structure mirrors backend. OpenAPI + Zod for all routes. See [apps/codesearch/adr/0001-codesearch-zoekt-orchestration.md](apps/codesearch/adr/0001-codesearch-zoekt-orchestration.md).

## User-defined namespaces

- (Leave blank – user populates)

## Components

- **backend** – `apps/backend`: REST + MCP + LangGraph server; entrypoint `src/server.ts` (Bun). LangGraph graphs in `src/graphs/`; model factory in `src/config/models.ts`. Owns Drizzle schema and migrations (including `repositories`).
- **codesearch** – `apps/codesearch`: Zoekt orchestration (POST /search proxy, POST /:repoId/index clone+index, GET/POST file routes); entrypoint `src/server.ts` (Bun). Mirrors backend `repositories` schema and performs lifecycle update for `index_ready`; repo cache and index paths fixed in code.
- **interactionGraph** – `apps/backend/src/graphs/interactionGraph/graph.ts` with node in `apps/backend/src/graphs/interactionGraph/nodes/codeInterpreter.ts` (`codeInterpretter`): LangGraph entrypoint for generic repository-aware Q&A, implemented with LangChain v1 `createAgent`; node instructions are inline with node implementation and repositories snapshot is provided in-system as TOON.
- **codeIngestionGraph** – `apps/backend/src/graphs/codeIngestionGraph/graph.ts` with first node in `apps/backend/src/graphs/codeIngestionGraph/nodes/reindex.ts`: queue-driven ingestion graph that currently triggers codesearch reindex for a repository and is invoked by backend queue worker jobs.
- **backend tools** – `apps/backend/src/tools/`: strongly typed LangChain tools (`list_repositories`, `search`, `list_files`, `get_file`) using `repositoryId` (`repo_` prefix) and TOON-encoded tool payloads.
- **backend DB context** – `apps/backend/src/db/client.ts`: provides `createDb()` (reads `process.env` internally), AsyncLocalStorage-backed `withDbContext(...)`, `getDb()`, and `getQueryDb()` for request-scoped database access.
- **backend repository model** – `apps/backend/src/models/repositories.ts`: central repository DB access helpers with Drizzle query API (`db.query.repositories.*`) and org scoping.
- **backend code ingestion queue** – `apps/backend/src/domain/codeIngestion/queue.ts` and `apps/backend/src/domain/codeIngestion/worker.ts`: enqueue + processing services backed by Postgres tables (`repository_ingestion_queue`, `repository_ingestion_errors`) with serialized per-repository claims, retries, and terminal error logging.
- **backend langsmith embedded API** – `apps/backend/src/langsmith/server.ts` + `apps/backend/src/routes/langsmith.ts`: in-process LangGraph API mounted at `/langsmith` behind `ENABLE_LANGSMITH`; initializes filesystem-backed langgraph-api storage and registers graphs from `src/graphs/index.ts` exports.

## Patterns

- Zod schemas are collocated with the code they validate (no central `src/schemas`).
- ADRs in `adr/` for major tooling and architecture decisions (see [adr/README.md](adr/README.md)).
- Dependency typing workarounds are handled via `pnpm patch` files under `patches/` (instead of editing files in `node_modules` directly).
- For `@hono/zod-openapi`, avoid local `createRoute` module overrides in app code; prefer dependency patching with minimal const-generic + schema inference relaxations to preserve `c.req.valid("json")` typing.
- When patching `@hono/zod-openapi` schema inference, keep request and response inference aligned: if request body typing is relaxed from `ZodType` to broader schema acceptance, also relax response `ExtractContent` typing (and route it through a shared helper) to avoid `TypedResponse<never, ...>` regressions in `app.openapi(...)` handlers.
- In `@hono/zod-openapi` declaration patches, avoid `Record<"schema", any>` direct indexing (`...["schema"]`) because it collapses request/response schema inference to `any`; use `Record<"schema", infer Schema>` and infer input/output/content from `Schema` instead.
- Codesearch indexing flow: `POST /{repoId}/index` removes prior clone, clones to `/data/repo-cache/<org_id>/<repo_id>`, then runs `zoekt-index` with a generated `.meta` containing Zoekt repo `ID` from backend `repositories.zoekt_repo_id`, writing shards to `/data/zoekt-index`.
- Backend repository creation triggers indexing asynchronously via codesearch and returns immediately; repository readiness is tracked in `repositories.index_ready` (default `false`, set to `true` after successful indexing in codesearch).
- Backend repository creation now resolves default branch/hash via codesearch `POST /{repoId}/resolve-ref`, enqueues ingestion jobs in Postgres, and processes them through `codeIngestionGraph` worker loop (2 retries before moving failures to `repository_ingestion_errors`).
- Docker local stack runs a dedicated internal `zoekt-webserver` service (`-rpc`, port 6070 on compose network); codesearch proxies `/search` to `http://zoekt-webserver:6070/api/search`.
- Codesearch route organization: keep route files focused on OpenAPI schema + handlers; move clone/index/repository access/path resolution into `src/domain/*` modules (e.g. `src/domain/indexing/service.ts`, `src/domain/repositories/*`).
- Ingestion testing pattern: backend ingestion flow tests live under `apps/backend/tests/` (route tests + worker policy/transition tests), and codesearch resolve-ref coverage uses Vitest in `apps/codesearch/tests/` (domain command parsing + route behavior with mocked repository access).
- Tool organization pattern: reusable agent tools live under `src/tools`; graph-specific instructions and nodes stay under `src/graphs/<graphName>/`.
- Tool payload pattern: serialize structured tool outputs to TOON before passing them to the LLM to reduce token usage.
- Chat graph persistence pattern: `apps/backend/src/graphs/chatGraph/graph.ts` compiles with a Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`) when `DATABASE_URL` is present and falls back to in-memory when it is not.
- `src/tools/` discipline: only agent-callable tools belong there; shared helpers should live outside (for example in `src/lib`).
- Tool export pattern: each tool file exports only its single `*Tool` entrypoint (inline handler + schema) to keep typing and wiring simple.
- DB access pattern: routes are wrapped in AsyncLocalStorage DB middleware; app code should use `getDb()` / `getQueryDb()` instead of passing DB instances via request context.
- Query pattern: prefer Drizzle query API (`db.query.<table>.findMany/findFirst`) and enforce org filtering in SQL-level conditions rather than runtime post-filtering.
- LangSmith integration pattern: mount LangGraph API in-process (no subprocess/proxy), gate with `ENABLE_LANGSMITH`, and resolve graph specs from `./src/graphs/index.ts:{exportName}` rather than generating `langgraph.json`.
