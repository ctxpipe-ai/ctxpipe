# @ctxpipe/backend

Backend service for ctxpipe: REST API and MCP server (via `@hono/mcp`), with LangChain/LangGraph for agent workflows. Built with Hono, deployable to **Cloudflare Workers** and **Bun-based containers**.

## TypeScript

The app uses a minimal tsconfig (Hono-style: `target` ES2022, `moduleResolution` Bundler, `strict`). For Cloudflare Worker type-checking (e.g. `Env` from bindings), run `pnpm exec wrangler types` and add the generated file (e.g. `worker-configuration.d.ts`) to `compilerOptions.types` in `tsconfig.json` if desired.

## Stack

- **Runtime**: Bun (container) / Cloudflare Workers (edge)
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

Server runs at `https://localhost:3000`. Set `PORT` and `DATABASE_URL` in env if needed. API routes are under `/v1` (e.g. `GET /v1/health`). OpenAPI 3.1 spec (JSON): `GET /openapi`. Scalar API docs (UI): `GET /doc`.

### Cloudflare Worker

```bash
pnpm dev:worker
```

Configure `wrangler.toml` and secrets (e.g. `DATABASE_URL`) per environment.

### LangGraph and LangSmith Studio

LangGraph runs in-process under `/langgraph` (threads, runs, assistants, etc.). Connect LangSmith Studio or Open LangGraph Studio with:

**LangSmith Studio:**  
[https://smith.langchain.com/studio/?baseUrl=https://localhost:3000/langgraph](https://smith.langchain.com/studio/?baseUrl=https://localhost:3000/langgraph)

**Open LangGraph Studio:**

```bash
npx @langgraph-js/ui
```

Then connect with baseUrl `https://localhost:3000/langgraph`.

Env vars: `MODEL_PROVIDER_API_KEY` (LLM), `LANGSMITH_API_KEY` (tracing). LangGraph uses `DATABASE_URL` (PostgreSQL) or in-memory storage.

## Scripts

| Script             | Description                   |
| ------------------ | ----------------------------- |
| `pnpm dev`         | Run server with Bun           |
| `pnpm dev:worker`  | Run Worker locally (wrangler) |
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
- `src/graphs/` – LangGraph workflows (hello graph); Hono integration TBD
- `src/platform/` – Future S3/R2, Neo4j adapters

## Deployment

- **Container**: Build from monorepo root:  
  `docker build -f apps/backend/Dockerfile .`  
  Image runs Bun and serves the built app on port 3000.

- **Cloudflare Worker**: From repo root or `apps/backend`, run  
  `pnpm exec wrangler deploy` (after configuring `wrangler.toml` and secrets).

## ADR

See [adr/0001-backend-service-stack-and-runtime.md](adr/0001-backend-service-stack-and-runtime.md) in this app for architecture decisions.
