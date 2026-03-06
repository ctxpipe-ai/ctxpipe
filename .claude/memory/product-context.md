# Product Context

## Project Overview
ctxpipe is a monorepo for a code-context platform by Appear. It provides code search, indexing (powered by Zoekt), a backend API with MCP integration, and a frontend UI — all aimed at enabling rich code understanding and navigation across repositories.

## Architecture
- **Monorepo**: pnpm workspaces + Turborepo, Biome for linting/formatting.
- **apps/backend**: Hono on Bun runtime. REST (OpenAPI 3.1 via @hono/zod-openapi) + MCP (via @hono/mcp). Drizzle ORM (beta/v1) on PostgreSQL. Better Auth for authentication. Neo4j for graph workloads. LangGraph JS for orchestration.
- **apps/codesearch**: Hono on Bun. Orchestrates Zoekt for code search/indexing. Shares Postgres with backend (read-only schema mirror). On-demand indexing only.
- **apps/ui**: TanStack Start (React + Vite). Tailwind CSS v4, React Aria (via shadcn registry), Geist typography. Storybook + Vitest.
- **Local dev**: Docker Compose (Postgres, Neo4j, backend on :3000, UI on :3002, codesearch on :3001, Zoekt internal).

## Key Stakeholders
- Appear engineering team (maintainers)
- AI agents (Cursor, Claude) that consume and extend the codebase

## Constraints
- Bun container runtime (not Node) for backend and codesearch
- Drizzle beta dist-tag (v1 API)
- All DB migrations live in apps/backend only
- Repository IDs: TEXT with `repo_` prefix + base32-encoded UUID
- Fixed paths for Zoekt index and repo cache (not env-configurable)
- Zod schemas collocated, not centralized

## Non-Goals
- Cloudflare Workers deployment (removed per ADR 0006)
- Automatic repo discovery/sync (indexing is on-demand only)
- Central schema registry

---
*Last updated: 2026-03-06 by Cursor*
