# Product Context

## Project Overview

ctxpipe is a monorepo for a code-context platform by Appear. It provides code search, indexing (powered by Zoekt), a backend API with MCP integration, and a frontend UI — all aimed at enabling rich code understanding and navigation across repositories.

Monorepo is managed with **pnpm workspaces** and **Turbo**. Apps live in `apps/`, shared packages in `packages/`.

## Architecture

- **Monorepo**: pnpm workspaces + Turborepo, Biome for linting/formatting.
- **apps/backend**: Hono on Bun. REST (OpenAPI 3.1 via @hono/zod-openapi) + MCP (@hono/mcp). Drizzle ORM (beta/v1) on PostgreSQL. Better Auth. Neo4j for graph. LangGraph JS for orchestration. See `.claude/memory/decisions/ADR-002-backend-service-stack-and-runtime.md`, `.claude/memory/decisions/ADR-005-langgraph-integration.md`.
- **apps/codesearch**: Hono on Bun. Orchestrates Zoekt (search proxy, on-demand indexing, file serving). Read-only Postgres `repositories`; structure mirrors backend. OpenAPI + Zod for all routes. See `.claude/memory/decisions/ADR-008-codesearch-zoekt-orchestration.md`.
- **apps/ui**: TanStack Start (React + Vite). Tailwind CSS v4, React Aria (via shadcn registry), Geist typography. Storybook + Vitest.
- **Local dev**: Docker Compose — Postgres, Neo4j, backend :3000, UI :3002, codesearch :3001, Zoekt internal.

## User-defined namespaces

(Leave blank – user populates)

## Components

- **backend** – `apps/backend`: REST + MCP + LangGraph server; entrypoint `src/server.ts` (Bun). LangGraph graphs in `src/graphs/`; model factory in `src/config/models.ts`. Owns Drizzle schema and migrations (including `repositories`).
- **codesearch** – `apps/codesearch`: Zoekt orchestration (POST /search proxy, POST /:repoId/index clone+index, GET/POST file routes); entrypoint `src/server.ts` (Bun). Mirrors backend `repositories` schema and performs lifecycle update for `index_ready`; repo cache and index paths fixed in code.
- **interactionGraph** – `apps/backend/src/graphs/interactionGraph/graph.ts` with node in `apps/backend/src/graphs/interactionGraph/nodes/codeInterpreter.ts` (`codeInterpretter`): LangGraph entrypoint for repository-aware Q&A; node instructions inline; repositories snapshot provided in-system as TOON.
- **codeIngestionGraph** – `apps/backend/src/graphs/codeIngestionGraph/graph.ts` (first node `reindex.ts`): queue-driven ingestion; triggers codesearch reindex; invoked by backend queue worker jobs.
- **backend tools** – `apps/backend/src/tools/`: LangChain tools (`list_repositories`, `search`, `list_files`, `get_file`) using `repositoryId` (`repo_` prefix) and TOON-encoded payloads.
- **backend DB context** – `apps/backend/src/db/client.ts`: `initDb(connectionString)` + `closeDb()`; AsyncLocalStorage `withSystemDbContext(...)` and `withOrgDbContext(orgId, ...)` for tenant-scoped `SET LOCAL app.organization_id`.
- **backend repository model** – `apps/backend/src/models/repositories.ts`: Drizzle query API, org scoping.
- **backend code ingestion queue** – `apps/backend/src/domain/codeIngestion/queue.ts` and `worker.ts`: Postgres-backed queue (`repository_ingestion_queue`, `repository_ingestion_errors`), retries, terminal error logging.
- **backend langsmith embedded API** – `apps/backend/src/langsmith/server.ts` + `src/routes/langsmith.ts`: in-process LangGraph API at `/langsmith` behind `ENABLE_LANGSMITH`; filesystem-backed langgraph-api storage; graphs from `src/graphs/index.ts`.
- **backend auth core** – `apps/backend/src/auth/config.ts`: Better Auth + Drizzle adapter (`usePlural`), experimental joins, organization + 2FA + passkey + bearer + device auth + OAuth (GitHub/Google/Microsoft when env set).
- **backend upstream JWT signer** – `apps/backend/src/auth/upstreamJwt.ts`: HS256 JWT for backend→upstream; short-lived bearer with subject, org, principal type, issuer, audience.
- **backend auth context route** – `apps/backend/src/routes/v1/auth.ts` (`GET /:orgSlug/api/v1/auth/me`): user/session context, inferred last login method.
- **codesearch JWT auth boundary** – `apps/codesearch/src/auth/jwt.ts` + `app.ts`: verify backend-issued bearer JWT, inject org context.
- **ui better-auth-ui** – `apps/ui/src/providers.tsx` + auth/account/organization routes: `AuthUIProviderTanstack`, `AuthQueryProvider`, `@daveyplate/better-auth-ui` AuthView/AccountView/OrganizationView.
- **ui app shell** – `apps/ui/src/components/AppShell.tsx` + SideNav: two-column flex, SideNav expanded/collapsed state, route-aware nav, authenticated settings routes.
- **backend conversations API + transport** – `apps/backend/src/routes/v1/conversations.ts` + domain/conversations (transport, renameStream, models): org-scoped `/:orgSlug/api/v1/conversations/*`, metadata in Postgres, LangGraph-thread history (`checkpoint_ns: conversations`), AI SDK data-stream SSE, composable stream enhancers.
- **ui chat workspace** – `apps/ui/src/features/chat/ChatWorkspace.tsx` + routes `$orgSlug.chat.tsx` / `$orgSlug.chat.$conversationId.tsx`: AppShell chat, AI Elements conversation/message, useChat, conversation sidebar, source filter default `ui`, first-message URL promotion to `/$orgSlug/chat/$conversationId`.

## Key Stakeholders

- Appear engineering team (maintainers)
- AI agents (Cursor, Claude) that consume and extend the codebase

## Constraints

- Bun container runtime (not Node) for backend and codesearch
- Drizzle beta dist-tag (v1 API)
- All DB migrations in apps/backend only
- Repository IDs: TEXT, `repo_` prefix + base32-encoded UUID
- Fixed paths for Zoekt index and repo cache (not env-configurable)
- Zod schemas collocated, not centralized

## Non-Goals

- Cloudflare Workers deployment (removed per ADR-007)
- Automatic repo discovery/sync (indexing is on-demand only)
- Central schema registry

---
*Last updated: 2026-03-06 by Cursor*
