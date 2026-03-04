# Backend – agent instructions

When working on `apps/backend`, follow these instructions in addition to the root [AGENTS.md](../../AGENTS.md).

- **API routes**: Define versioned REST endpoints with `@hono/zod-openapi` (`createRoute` + Zod schemas). Public versioned API routes are org-scoped under **`/:orgSlug/api/v1`**.
- **OpenAPI**: Use OpenAPI 3.1. Serve the **raw spec (JSON)** at **`/.docs/openapi`** and **Scalar API reference (UI)** at **`/.docs/api-reference`**. Use `getOpenAPI31Document` for the spec; point Scalar at `/.docs/openapi`.
- **MCP**: Integrate MCP into the Hono app via `@hono/mcp` (Streamable HTTP at `/mcp`). Do not run a separate MCP server process.
- **Container runtime**: Use **Bun** for the container/on-prem entrypoint, not Node.
- **Zod schemas**: Collocate schemas with the code they describe (routes, domain, DB). Do not introduce a central `src/schemas` folder.
- **Drizzle**: Use the **`beta`** dist-tag for `drizzle-orm` and `drizzle-kit`; follow the v1 API. See [adr/0002-drizzle-beta.md](adr/0002-drizzle-beta.md).
- **Transactions**: Always wrap multi-table operations in a database transaction using `db.transaction(async (tx) => { ... })` to ensure data consistency. Use the transaction object `tx` for all operations within the transaction.
  **DB migration**: Don't generate migration sql files yourself. Runs pnpm run db:generate instead
- **TypeScript**: Keep `tsconfig` minimal (Hono-style). Enable stricter options: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.

## Local development

- **Docker Compose** (repo root): Local dev stack is defined in the root `docker-compose.yml`. It runs Postgres, Neo4j, and the backend. Root `pnpm dev` runs **only** `docker compose up` (no Turbo); the backend runs inside the stack.
- **Backend**: `backend-bun` — Bun dev server (`pnpm --filter @ctxpipe/backend dev`). Use `docker compose up` or root `pnpm dev`. API at `http://localhost:3000`.
- **Env**: Backend expects `DATABASE_URL` (Postgres) and optional `NEO4J_URI` (Neo4j Bolt). See `src/config/env.ts`.
- **Infra-only**: To run the backend on the host against Compose databases, run `docker compose up -d postgres neo4j`, then set `DATABASE_URL` (and optionally `NEO4J_URI`) and run `pnpm dev` from `apps/backend`. See [adr/0003-local-development-docker-compose.md](adr/0003-local-development-docker-compose.md).
