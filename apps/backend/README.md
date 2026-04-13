# ctxpipe/backend

<p align="center">
  <img src="../docs/public/ctxpipe-logo-readme.png" alt="ctx| logo" width="480" />
</p>

<p align="center">
  <a href="https://img.shields.io/badge/License-ELv2-0f766e.svg"><img src="https://img.shields.io/badge/License-ELv2-0f766e.svg" alt="License: ELv2" /></a>
</p>

<p align="center">
  <a href="https://ctxpipe.ai">Website</a>
  ·
  <a href="https://github.com/ctxpipe-ai/ctxpipe/issues">Issues</a>
  ·
  <a href="https://docs.ctxpipe.ai">Docs</a>
</p>

The context layer for AI agents — infrastructure that helps coding agents understand your codebase, standards, and how work gets done in your org. Git-first instruction hierarchy (AGENTS.md, skills, MCP), a knowledge graph that learns from your repos, docs, tools, and usage, and an agent-agnostic MCP surface so Cursor, Claude Code, Copilot, and other tools share one connection.

`@ctxpipe/backend` is the core API service for ctx|.

## How does ctx| work? 

<p align="center">
  <img src="../ui/public/images/ctxpipe-onboarding-diagram.svg" alt="ctx| diagram" width="1080" />
</p>




## Quick Start (Local Deploy)

For the easiest local deployment experience, use Docker Compose from the repo root:

```bash
git clone https://github.com/ctxpipe-ai/ctxpipe.git
cd ctxpipe
cp docker-compose.env.example .env
pnpm install
pnpm start
```

Before `pnpm start`, set at least these values in `.env`:

- `AUTH_SECRET` (minimum 32 characters)
- `AUTH_BASE_URL`
- `CTXPIPE_PUBLIC_APP_URL`

## Developer Mode (Host + Docker Infra)

If you are actively developing code, run app services on host and infra in Docker:

```bash
pnpm install
pnpm dev:infra
pnpm dev
```

Use `https://app.ctxpipe.localhost` for integrated local development.

## What it provides

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

## API & Endpoints

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

## Scripts

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

## Project Structure

- `src/app` – Hono app wiring and middleware
- `src/routes` – REST and webhook routes
- `src/auth` – Better Auth configuration
- `src/mcp` – MCP tools and server integration
- `src/db` – schema and database access
- `src/openworkflow` – ingestion and sync workflows
- `src/graphs` – LangGraph pipelines

## Licence

This project is released under **Elastic License 2.0 (ELv2)**.  
See the open-source guide: [docs.ctxpipe.ai/docs/resources/open-source](https://docs.ctxpipe.ai/docs/resources/open-source)
