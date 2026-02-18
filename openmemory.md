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
- **codesearch** – `apps/codesearch`: Zoekt orchestration (POST /search proxy, POST /:repoId/index clone+index, GET/POST file routes); entrypoint `src/server.ts` (Bun). Read-only DB; repo cache and index paths fixed in code.

## Patterns

- Zod schemas are collocated with the code they validate (no central `src/schemas`).
- ADRs in `adr/` for major tooling and architecture decisions (see [adr/README.md](adr/README.md)).
- Dependency typing workarounds are handled via `pnpm patch` files under `patches/` (instead of editing files in `node_modules` directly).
- For `@hono/zod-openapi`, avoid local `createRoute` module overrides in app code; prefer dependency patching with minimal const-generic + schema inference relaxations to preserve `c.req.valid("json")` typing.
- When patching `@hono/zod-openapi` schema inference, keep request and response inference aligned: if request body typing is relaxed from `ZodType` to broader schema acceptance, also relax response `ExtractContent` typing (and route it through a shared helper) to avoid `TypedResponse<never, ...>` regressions in `app.openapi(...)` handlers.
- In `@hono/zod-openapi` declaration patches, avoid `Record<"schema", any>` direct indexing (`...["schema"]`) because it collapses request/response schema inference to `any`; use `Record<"schema", infer Schema>` and infer input/output/content from `Schema` instead.
- Codesearch indexing flow: `POST /{repoId}/index` removes prior clone, clones to `/data/repo-cache/<org_id>/<repo_id>`, then runs `zoekt-index` with a generated `.meta` containing Zoekt repo `ID` from backend `repositories.zoekt_repo_id`, writing shards to `/data/zoekt-index`.
- Docker local stack runs a dedicated internal `zoekt-webserver` service (`-rpc`, port 6070 on compose network); codesearch proxies `/search` to `http://zoekt-webserver:6070/api/search`.
- Codesearch route organization: keep route files focused on OpenAPI schema + handlers; move clone/index/repository access/path resolution into `src/domain/*` modules (e.g. `src/domain/indexing/service.ts`, `src/domain/repositories/*`).
