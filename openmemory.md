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
- **codesearch** – `apps/codesearch`: Zoekt orchestration (POST /search proxy, POST /:repoId/index, GET/POST file routes); entrypoint `src/server.ts` (Bun). Read-only DB; repo cache and index paths fixed in code.

## Patterns

- Zod schemas are collocated with the code they validate (no central `src/schemas`).
- ADRs in `adr/` for major tooling and architecture decisions (see [adr/README.md](adr/README.md)).
