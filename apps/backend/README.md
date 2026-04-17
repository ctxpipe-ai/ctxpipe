# `@ctxpipe/backend`

Core HTTP API and MCP service for [ctx|](https://ctxpipe.ai). Built with **Hono** on **Bun**, **Better Auth**, **PostgreSQL** + **Drizzle**, and workflow orchestration for ingestion and agent tooling.

**Monorepo:** clone, environment, Compose deployment, and host dev flows live in the [repository root README](../../README.md). Run **`pnpm dev:infra`** and **`pnpm dev`** from the repo root unless you are intentionally running only this package.

## What this package provides

- org-scoped REST APIs (`/:orgSlug/api/v1/*`)
- MCP endpoint (`/mcp`) for agent integrations
- ingestion orchestration for repository indexing and context extraction
- authentication and organisation access control

## Stack

- Runtime: Bun (container/runtime target)
- HTTP: Hono
- API contracts: `@hono/zod-openapi` + Zod
- Auth: Better Auth
- DB: PostgreSQL + Drizzle ORM
- Orchestration: OpenWorkflow + LangGraph
- Testing: Vitest

## API & endpoints

- REST (org-scoped): `/:orgSlug/api/v1/*`
- OpenAPI JSON: `/.docs/openapi`
- API reference UI (Scalar): `/.docs/api-reference`
- MCP endpoint: `/mcp?orgSlug=<slug>`
- Status: `/.status`

## Webhooks (GitHub App)

- Endpoint: `POST /api/v1/webhook/github`
- HMAC verification via `GITHUB_WEBHOOK_SECRET`
- `push` events to default branch trigger repository ingestion workflow enqueue
- `repository.created` can trigger repository sync when auto-sync options are enabled

## Scripts (this package)

| Script | Description |
| --- | --- |
| `pnpm dev` | Run backend + worker in dev |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run built server |
| `pnpm test` | Run test suite |
| `pnpm lint` | Run Biome lint |
| `pnpm format` | Run Biome format |
| `pnpm db:generate` | Generate Drizzle migration |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Open Drizzle Studio |

## Project structure

- `src/app` – Hono app wiring and middleware
- `src/routes` – REST and webhook routes
- `src/auth` – Better Auth configuration
- `src/mcp` – MCP tools and server integration
- `src/db` – schema and database access
- `src/openworkflow` – ingestion and sync workflows
- `src/graphs` – LangGraph pipelines

## Licence

Released under **Elastic License 2.0 (ELv2)** — same terms as the parent repo; details: [open-source (docs)](https://docs.ctxpipe.ai/docs/resources/open-source).
