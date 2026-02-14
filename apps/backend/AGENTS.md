# Backend – agent instructions

When working on `apps/backend`, follow these instructions in addition to the root [AGENTS.md](../../AGENTS.md).

- **API routes**: Define versioned REST endpoints with `@hono/zod-openapi` (`createRoute` + Zod schemas). All versioned API routes live under the **`/v1`** prefix. Non-versioned endpoints (e.g. MCP, docs) stay at the root (no `/v1`).
- **OpenAPI**: Use OpenAPI 3.1. Serve the **raw spec (JSON)** at **`/openapi`** and **Scalar API reference (UI)** at **`/doc`**, both at the root (no prefix). Use `getOpenAPI31Document` for the spec; point Scalar at `/openapi`.
- **MCP**: Integrate MCP into the Hono app via `@hono/mcp` (Streamable HTTP at e.g. `/mcp`). Do not run a separate MCP server process.
- **Container runtime**: Use **Bun** for the container/on-prem entrypoint, not Node.
- **Zod schemas**: Collocate schemas with the code they describe (routes, domain, DB). Do not introduce a central `src/schemas` folder.
- **Drizzle**: Use the **`beta`** dist-tag for `drizzle-orm` and `drizzle-kit`; follow the v1 API. See [adr/0002-drizzle-beta.md](adr/0002-drizzle-beta.md).
- **TypeScript**: Keep `tsconfig` minimal (Hono/Wrangler-style). Enable stricter options: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.

## Local development

- **Docker Compose** (repo root): Local dev stack is defined in the root `docker-compose.yml`. It runs Postgres, Neo4j, and the backend. Root `pnpm dev` runs **only** `docker compose up` (no Turbo); the backend runs inside the stack.
- **Two backend modes** (same port **3000**):
  - **Default**: `backend-bun` — Bun dev server (`pnpm --filter @ctxpipe/backend dev`). Use `docker compose up` or root `pnpm dev`.
  - **Cloudflare**: `backend-worker` — Wrangler dev (`pnpm --filter @ctxpipe/backend dev:worker`). Use `docker compose --profile cloudflare up backend-worker postgres neo4j`. Both expose the API at `http://localhost:3000` so frontends/clients do not need to change when switching runtimes.
- **Env**: Backend expects `DATABASE_URL` (Postgres) and optional `NEO4J_URI` (Neo4j Bolt). See `src/config/env.ts`. For Wrangler dev (on host or in container), use `apps/backend/.dev.vars` (copy from `.dev.vars.example`); Compose injects env into the worker container.
- **Infra-only**: To run the backend on the host against Compose databases, run `docker compose up -d postgres neo4j`, then set `DATABASE_URL` (and optionally `NEO4J_URI`) and run `pnpm dev` or `pnpm dev:worker` from `apps/backend`. See [adr/0003-local-development-docker-compose.md](adr/0003-local-development-docker-compose.md).
