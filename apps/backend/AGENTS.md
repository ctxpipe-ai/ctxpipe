# Backend – agent instructions

When working on `apps/backend`, follow these instructions in addition to the root [AGENTS.md](../../AGENTS.md).

- **API routes**: Define versioned REST endpoints with `@hono/zod-openapi` (`createRoute` + Zod schemas). Public versioned API routes are org-scoped under **`/:orgSlug/api/v1`**.
- **OpenAPI**: Use OpenAPI 3.1. Serve the **raw spec (JSON)** at **`/.docs/openapi`** and **Scalar API reference (UI)** at **`/.docs/api-reference`**. Use `getOpenAPI31Document` for the spec; point Scalar at `/.docs/openapi`.
- **MCP**: Integrate MCP into the Hono app via `@hono/mcp` (Streamable HTTP at `/mcp`). Do not run a separate MCP server process.
- **Container runtime**: Use **Bun** for the container/on-prem entrypoint, not Node.
- **Zod schemas**: Collocate schemas with the code they describe (routes, domain, DB). Do not introduce a central `src/schemas` folder.
- **Drizzle**: Use the **`beta`** dist-tag for `drizzle-orm` and `drizzle-kit`; follow the v1 API. See [.claude/memory/decisions/ADR-003-drizzle-beta.md](../../.claude/memory/decisions/ADR-003-drizzle-beta.md).
- **Transactions**: Always wrap multi-table operations in a database transaction using `db.transaction(async (tx) => { ... })` to ensure data consistency. Use the transaction object `tx` for all operations within the transaction.
- **DB migration**: Don't generate migration SQL files yourself. Run `pnpm run db:generate` instead. See [.agents/skills/drizzle-migrations/](../../.agents/skills/drizzle-migrations/) for the full workflow.
- **TypeScript**: Keep `tsconfig` minimal (Hono-style). Enable stricter options: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.

## Agent tools (ingestion + conversation)

- Shared explorer tools live in [`src/tools/repoExplorerTools.ts`](src/tools/repoExplorerTools.ts): `list_files`, `search`, `find_symbol_definitions` (Zoekt `sym:`), `find_symbol_references` (heuristic regexp), `get_file`. Symbol index quality depends on ctags during Zoekt indexing. The production **codesearch** image installs CodeGraphContext and asserts `cgc` is on `PATH` (`cgc watch --help` at build); see [`apps/codesearch/Dockerfile`](../codesearch/Dockerfile).

## Local development

- **Host dev (recommended)**: Follow the **Agent runbook** in root [AGENTS.md](../../AGENTS.md) — run **`pnpm dev:infra`** then **`pnpm dev`** from the **repo root** (not from `apps/backend`). Backend **`migrate`** runs inside **`pnpm db:migrate`** / Turbo before dev servers; it **`source`s** [`scripts/worktree-db.sh`](../../scripts/worktree-db.sh) then `drizzle-kit migrate` (see [`package.json`](package.json) **`db:migrate`**). Open **`app.ctxpipe`** in the browser for the integrated app; the backend proxies unmatched routes to **`UI_PROXY_URL`** ([`src/routes/ui.ts`](src/routes/ui.ts)).
- **Env**: `DATABASE_URL` (Postgres), `GRAPH_DB_URI` (FalkorDB / OpenCypher; e.g. **`redis://localhost:6379`** when infra is on the host). See `src/config/env.ts` and [Graph databases (docs)](../docs/content/docs/self-hosting/graph-databases.mdx).
- **Infra-only** (backend alone on host): e.g. `docker compose up -d postgres falkordb`, then **`pnpm dev`** from **`apps/backend`** with env pointing at host ports — or use root **`pnpm dev:backend`**.

### Parallel worktrees

- **Postgres**: One server (**`localhost:5433`** typical), **one DB per linked git worktree** (`ctxpipe_<sanitized_branch>`). **`pnpm db:migrate`** (repo root) runs **`source ../../scripts/worktree-db.sh`** before Drizzle; linked worktrees need **`psql`** on `PATH`. **Dev servers** read **`apps/backend/.env.local`** — set **`DATABASE_URL`** there to the same database name migrate uses (see root [AGENTS.md](../../AGENTS.md) runbook).
- **Public URL**: [portless](https://portless.sh/) or non-default port: align **`AUTH_BASE_URL`** and **`AUTH_ALLOWED_ORIGINS`** with the browser origin (**`PORTLESS_URL`** when applicable). Defaults in `src/config/env.ts`.
- **MCP URLs**: HTTP MCP is served by this app (see **MCP** above); base URL and org slug follow your dev env — see root [AGENTS.md](../../AGENTS.md) (parallel worktrees + runbook) and [`.env.example`](.env.example).

### Better Auth JWT / `jwkss`

The **`jwt()`** plugin persists JWKS material in **`jwkss`**; private keys are encrypted with **`AUTH_SECRET`**. If that secret changes (new `.env.local`, copied DB from another machine, etc.) while old rows remain, **`get-session`** and other JWT paths can return **500** with *Failed to decrypt private key*. **Dev recovery**: against the same database your backend uses, run **`DELETE FROM jwkss;`** (host **`psql`**, GUI client, or from repo root with infra up: **`docker compose --profile infra exec -T postgres psql -U ctxpipe -d <db> -c 'DELETE FROM jwkss;'`** — **`<db>`** = name in **`DATABASE_URL`**), restart the backend, and sign in again so keys regenerate. **Production**: rotate secrets only with a planned JWKS/session strategy—do not delete keys lightly.
