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
# From repo root (recommended): pnpm dev — portless HTTPS + env for split hosts
pnpm dev
```

With **`pnpm dev`** from the repo root, the API is served through **`portless app.ctxpipe`** (default **`.localhost`**; worktree branch prefix per [portless](https://port1355.dev/)); Bun listens on plain HTTP on the ephemeral **`PORT`** from portless. **Use `app.ctxpipe` in the browser** for the full app: non-API paths are proxied to the UI origin (**`UI_PROXY_URL`**, e.g. **`ui.ctxpipe`** in host dev)—see **`src/routes/ui.ts`**. Do not open **`ui.ctxpipe`** or raw localhost ports for integrated auth/API + UI. For running the backend dev server from **`apps/backend`** alone, run **`pnpm dev`** from the repo root first so **`AUTH_BASE_URL`** / **`UI_PROXY_URL`** match **`portless get`**, or align env manually. Set `DATABASE_URL` in env if needed. API routes are org-scoped under `/:orgSlug/api/v1` (e.g. `GET /acme/api/v1/health`). OpenAPI 3.1 spec (JSON): `GET /.docs/openapi`, Scalar API docs (UI): `GET /.docs/api-reference`, Global status endpoint: `GET /.status`.

### LangSmith Studio (dev only)

Set `ENABLE_LANGSMITH=true` to mount an embedded LangGraph API app under **`/langsmith`**.

**LangSmith Studio:**  
Use **`AUTH_BASE_URL`** in the printed link when LangSmith is enabled (defaults to `http://localhost:3000` if unset).

Implementation: `src/routes/langsmith.ts` — initializes LangGraph API storage in-process, registers graphs from `src/graphs/index.ts`, and mounts routes directly into backend. See [.ai/memory/decisions/ADR-006-langsmith-studio-dev-routes.md](../../.ai/memory/decisions/ADR-006-langsmith-studio-dev-routes.md).

Env: `ENABLE_LANGSMITH=true`, `MODEL_PROVIDER_API_KEY` (LLM). LLM tracing uses OpenTelemetry (see Observability below).

### Observability (Better Stack + LangFuse)

When **`pnpm dev:infra`** is running (includes the `otel-collector` service), the collector fans out traces/logs to Better Stack and LangFuse.

1. Create `apps/otel-collector/.env` and `.env.local` from the example; put your tokens in `.env.local`:
   ```bash
   cp apps/otel-collector/.env.example apps/otel-collector/.env
   cp apps/otel-collector/.env.example apps/otel-collector/.env.local
   ```
2. Fill in `BETTER_STACK_SOURCE_TOKEN`, `LANGFUSE_*` vars (see `.env.example` for how to derive `LANGFUSE_AUTH_STRING` and `LANGFUSE_OTLP_ENDPOINT`)
3. Restart infra: `pnpm dev:infra` (or `docker compose up -d otel-collector` if the stack is already up)

### GitHub App Webhook Testing (Smee)

The GitHub App webhook endpoint is `POST /api/v1/webhook/github` and verifies GitHub’s HMAC signature using `GITHUB_WEBHOOK_SECRET`.

To test GitHub webhooks locally, use `smee-client` to create a temporary `https://smee.io/...` webhook URL (https://smee.io/naliyA6yt5p9UmLf is the default) and forward deliveries to your local server.

1. Spin up ctxpipe:
   ```bash
   pnpm dev
   ```
2. Start Smee forwarding (forwards to `http://127.0.0.1:$PORT/api/v1/webhook/github`):
   ```bash
   pnpm --filter @ctxpipe/backend forward-github-webhook
   # or 
   SMEE_URL="https://smee.io/custom-one-that-you-created" pnpm --filter @ctxpipe/backend forward-github-webhook
   ```
3. Configure your GitHub App:
   - GitHub -> `Settings` -> `GitHub Apps` -> ctxpipe agent localhost -> `Webhook`
   - Set `Webhook URL` to the `https://smee.io/...` URL (https://smee.io/naliyA6yt5p9UmLf is the current one configured for local testing) printed by the command (do not append the `/api/v1/webhook/github` path)
   - Set the webhook `Secret` to the same value as `GITHUB_WEBHOOK_SECRET`
   - Deliver a test webhook (or trigger real events like `ping`, `push`, `repository`)
   - Or re-deliver previous events from smee UI

Troubleshooting:
- If `GITHUB_WEBHOOK_SECRET` is missing, the endpoint returns `503`.
- If the signature doesn’t match, the endpoint returns `401`.

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
