# @ctxpipe/backend

Backend service for ctxpipe: REST API and MCP server (via `@hono/mcp`), with LangChain/LangGraph for agent workflows. Built with Hono, deployable to **Bun-based containers**.

## TypeScript

The app uses a minimal tsconfig (Hono-style: `target` ES2022, `moduleResolution` Bundler, `strict`).

## Stack

- **Runtime**: Bun (container)
- **HTTP**: Hono
- **DB**: PostgreSQL via Drizzle ORM (provider-agnostic `DATABASE_URL`, e.g. Neon or on-prem)
- **Auth**: Better Auth (scaffolded)
- **API**: `@hono/zod-openapi` — routes defined with `createRoute` + Zod schemas; request/response validation and OpenAPI 3.0 spec generated automatically
- **Validation**: Zod (via `@hono/zod-openapi`), collocated with routes and domain code
- **Testing**: Vitest

## Local development

### Bun (container-like)

```bash
pnpm install
pnpm dev
```

Server runs at `https://localhost:3000`. Set `PORT` and `DATABASE_URL` in env if needed. API routes are org-scoped under `/:orgSlug/api/v1` (e.g. `GET /acme/api/v1/health`). OpenAPI 3.1 spec (JSON): `GET /.docs/openapi`. Scalar API docs (UI): `GET /.docs/api-reference`. Global status endpoint: `GET /.status`.

### LangSmith Studio (dev only)

Set `ENABLE_LANGSMITH=true` to mount an embedded LangGraph API app under **`/langsmith`**.

**LangSmith Studio:**  
[https://smith.langchain.com/studio/?baseUrl=https://localhost:3000/langsmith](https://smith.langchain.com/studio/?baseUrl=https://localhost:3000/langsmith)

Implementation: `src/routes/langsmith.ts` — initializes LangGraph API storage in-process, registers graphs from `src/graphs/index.ts`, and mounts routes directly into backend. See [.ai/memory/decisions/ADR-006-langsmith-studio-dev-routes.md](../../.ai/memory/decisions/ADR-006-langsmith-studio-dev-routes.md).

Env: `ENABLE_LANGSMITH=true`, `MODEL_PROVIDER_API_KEY` (LLM). LLM tracing uses OpenTelemetry (see Observability below).

### Observability (Better Stack + LangFuse)

When using `docker compose up` (root `pnpm dev`), an OpenTelemetry Collector runs and fans out traces/logs to Better Stack and LangFuse.

1. Create `apps/otel-collector/.env` and `.env.local` from the example; put your tokens in `.env.local`:
   ```bash
   cp apps/otel-collector/.env.example apps/otel-collector/.env
   cp apps/otel-collector/.env.example apps/otel-collector/.env.local
   ```
2. Fill in `BETTER_STACK_SOURCE_TOKEN`, `LANGFUSE_*` vars (see `.env.example` for how to derive `LANGFUSE_AUTH_STRING` and `LANGFUSE_OTLP_ENDPOINT`)
3. Ensure root `.env` exists (`cp .env.example .env` at repo root) for database URL
4. Restart `docker compose up`

## Scripts

| Script             | Description                   |
| ------------------ | ----------------------------- |
| `pnpm dev`         | Run server with Bun           |
| `pnpm build`       | Compile TypeScript to `dist/` |
| `pnpm start`       | Run built server (Bun)        |
| `pnpm test`        | Run Vitest                    |
| `pnpm lint`        | Biome lint                    |
| `pnpm format`      | Biome format                  |
| `pnpm db:generate` | Drizzle: generate migrations  |
| `pnpm db:migrate`  | Drizzle: run migrations       |
| `pnpm db:studio`   | Drizzle Studio                |

## Layout

- `src/app/` – Hono app composition
- `src/routes/` – REST route modules (`createRoute` + Zod schemas; OpenAPI + validation)
- `src/db/` – Drizzle client and schema
- `src/auth/` – Better Auth config
- `src/mcp/` – MCP router and tools (`/mcp`)
- `src/config/` – Env parsing (Zod), model factory (fast/medium/high tiers)
- `src/graphs/` – LangGraph workflows (hello graph)
- `src/langsmith/` – Embedded LangGraph API wiring (dev only, under `/langsmith`)
- `src/platform/` – Future S3/R2, Neo4j adapters

## Deployment

- **Container**: Build from monorepo root:  
  `docker build -f apps/backend/Dockerfile .`  
  Image runs Bun and serves the built app on port 3000.

## ADR

See [.ai/memory/decisions/ADR-002-backend-service-stack-and-runtime.md](../../.ai/memory/decisions/ADR-002-backend-service-stack-and-runtime.md) for architecture decisions.
