# Backend – agent instructions

When working on `apps/backend`, follow these instructions in addition to the root [AGENTS.md](../../AGENTS.md).

- **API routes**: Define versioned REST endpoints with `@hono/zod-openapi` (`createRoute` + Zod schemas). Public versioned API routes are org-scoped under **`/:orgSlug/api/v1`**.
- **OpenAPI**: OpenAPI 3.1. Serve the JSON spec (`getOpenAPI31Document`) at `/.docs/openapi`, and the Scalar API reference, pointed at that spec, at `/.docs/api-reference`.
- **MCP (product)**: serve the product MCP in-process with the API via `@hono/mcp` (Streamable HTTP at `/mcp`), never as a separate process. The agent tooling MCPs in [`.mcp.json`](../../.mcp.json) are editor-side helpers, not a second product server.
- **Container runtime**: Use **Bun** for the container/on-prem entrypoint, not Node.
- **Zod schemas**: Collocate schemas with the code they describe (routes, domain, DB). Do not introduce a central `src/schemas` folder.
- **Drizzle**: Use the **`beta`** dist-tag for `drizzle-orm` and `drizzle-kit`; follow the v1 API. See [.ai/memory/decisions/ADR-003-drizzle-beta.md](../../.ai/memory/decisions/ADR-003-drizzle-beta.md).
- **Transactions**: wrap each multi-table operation in `db.transaction(async (tx) => { ... })`, and use `tx` for every query inside it.
- **DB migration**: Don't generate migration SQL files yourself. Run `pnpm run db:generate` instead. See [.agents/skills/drizzle-migrations/](../../.agents/skills/drizzle-migrations/) for the full workflow.
- **Connections**: every connector (GitHub, Confluence/Forge, Slack, Linear, Notion, PagerDuty, Buildkite, Plain) is a row in `connections` (`con_*`, `type`, `config` jsonb). The legacy `github_installations` / `forge_installations` tables are removed. Repos use `github_connection_id`; Confluence tables use `connection_id`; the other connectors keep their binding in `connections.config`. An org can have more than one connector: use an explicit `connectionId`, a list endpoint, or `repository_id`. `GET /:orgSlug/api/v1/connectors` returns metadata only (no `config`). To design or change a connector (also provider read fan-out and import resume), use the **[source-connectors skill](../../.agents/skills/source-connectors/SKILL.md)**. See [ADR-018](../../.ai/memory/decisions/ADR-018-unified-connections-table.md), [ADR-057](../../.ai/memory/decisions/ADR-057-buildkite-connector-sources-only.md) (Buildkite, Workspace sources only), [ADR-059](../../.ai/memory/decisions/ADR-059-plain-connector-sources-only.md) (Plain, Workspace sources only), and the connector ADRs in [decisions/index.md](../../.ai/memory/decisions/index.md).
- **TypeScript**: Keep `tsconfig` minimal (Hono-style). Enable stricter options: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.

## Logging (evlog)

- **Do not use `console.*`** in `apps/backend` — logs go through **evlog** for one wide-event shape, sampling, and OTLP drain. (evlog itself may write to stderr when a drain fails.)
- **Hono middleware and route handlers**: use **`getLogger()`** from [`src/observability/logger.ts`](src/observability/logger.ts). It returns the request-scoped logger from `evlog/hono` (same instance as `c.var.log`). Prefer `getLogger().error(err, { step: "…" })` for failures; use `info` / `warn` with structured context. Do not pass `RequestLogger` through helpers or call `c.get("log")` for logging.
- **Code called only from workflows / graph nodes**: also use `getLogger()` (the workflow logger is in AsyncLocalStorage).
- **No request/workflow logger** (domain helpers, DB hooks, early bootstrap): use **`log`** from [`src/observability/logger.ts`](src/observability/logger.ts) (re-exported evlog `log`: `log.info({ step, message, ... })` / `log.error` — emits immediately). For workflow-scoped wide events that buffer until flush, use **`createLogger`** + **`withLogger`** / **`emit()`** as today. Call **`initEvlog()`** once at script entry if the process does not go through `server.ts`.
- **Set the logger once per entrypoint**: `defineWorkflow` in [`src/openworkflow/defineObservedWorkflow.ts`](src/openworkflow/defineObservedWorkflow.ts) wraps every workflow body in `withLogger`, and the `evlog/hono` middleware sets a logger for each request. Define each workflow with that `defineWorkflow`, never with `openworkflow` directly (an Oxlint rule enforces this). Do not call `withLogger` in a workflow body. To add per-input log fields, set `logFields` in the workflow spec. A new entrypoint (queue or cron handler, script) must set a logger, or use `log`.
- **Vitest**: `src/test/setup-evlog.ts` calls `initLogger({ enabled: false })` via `test.setupFiles`. Never `vi.mock` `observability/logger.js` (`getLogger` / `withLogger` / `createLogger` / `flushWorkflowLog` / `log`). `enabled: false` no-ops emit globally (no stdout, no drains). Do **not** use `silent` — that still sends events to drains. If a test throws `getLogger: no logger in context`, fix the entrypoint so that it sets the logger, or run a pure helper inside `withLogger` in the test. _Proof_ for sandbox/git/routes is a real workdir + `app.request` ([`write-workflow-native.contract.test.ts`](src/domain/workspaces/write-workflow-native.contract.test.ts)), not `vi.mock` of owned modules. See [tdd/mocking.md](../../.agents/skills/tdd/mocking.md).

## Testing

What to fake: [root AGENTS.md → Testing](../../AGENTS.md#testing). Name Postgres tests `*.integration.test.ts`. The full backend suite runs in [CI](../../.github/workflows/ci.yaml) with Postgres and native tools; the [Claude plugin workflow](../../.github/workflows/claude-plugin-test.yaml) runs focused auth and MCP tests.

[`test/msw.ts`](test/msw.ts): `useMswServer`, `codesearchNotFound`. [`test/spans.ts`](test/spans.ts): `recordSpans`. [`test/db.ts`](test/db.ts): `describeWithDatabase`, `seedOrg`, `cleanupSeededOrg`. evlog assertions: pattern in [`src/mcp/transport.test.ts`](src/mcp/transport.test.ts).

## Agent tools (ingestion + conversation)

- Shared explorer tools (`glob_files`, `search`, `find_symbol_definitions` (Zoekt `sym:`), `find_symbol_references` (heuristic regexp), `structural_search` (ast-grep), SCIP `graph_*`, `get_file`) live in [`src/tools/repoExplorerTools.ts`](src/tools/repoExplorerTools.ts). The production **codesearch** image installs the SCIP indexer matrix and ast-grep; see [`apps/codesearch/Dockerfile`](../codesearch/Dockerfile).

### Public MCP tools

`/mcp` exposes the seven read tools of [ADR-051](../../.ai/memory/decisions/ADR-051-mcp-read-surface.md) and the `ctxpipe://{org}/{workspace}/{+ref}` resource template. [`src/mcp/tools.ts`](src/mcp/tools.ts) registers them in one place. Each tool call and each resource read has an `mcp.tool <name>` or `mcp.resource <name>` span with a call id. The MCP runs no LLM, so it has no Langfuse trace.

## Local development

- **Host dev**: follow the runbook in root [AGENTS.md](../../AGENTS.md#local-development), from the repo root. `pnpm db:migrate` runs [`scripts/db-migrate.sh`](../../scripts/db-migrate.sh): it migrates as the owner, then GRANTs `ctxpipe_app`. The backend proxies unmatched routes to `UI_PROXY_URL` ([`src/routes/ui.ts`](src/routes/ui.ts)).
- **Env**: `DATABASE_URL` in `apps/backend/.env.local` uses `ctxpipe_app` on the database that migrate uses (one database per linked worktree). `GRAPH_DB_URI` is FalkorDB / OpenCypher. See `src/config/env.ts` and [Graph databases (docs)](../docs/content/docs/self-hosting/(configuration)/graph-databases.mdx).
- **Backend alone**: start `docker compose up -d postgres falkordb`, then run root `pnpm dev:backend`. Or run `pnpm dev` from `apps/backend` with env that points at the host ports.
- **Public URL**: with portless or a non-default port, set `AUTH_BASE_URL` and `AUTH_ALLOWED_ORIGINS` to the browser origin (`PORTLESS_URL` when it applies).
- **MCP URLs**: this app serves the HTTP MCP (see **MCP (product)**). The base URL and the org slug follow your dev env: see root [AGENTS.md](../../AGENTS.md) and [`.env.example`](.env.example).
- **MCP OAuth**: the OAuth provider issues JWT access tokens (`oauthProvider` in [`src/auth/config.ts`](src/auth/config.ts)). They live 4h, but **MCP clients must refresh** before expiry. A stale Bearer token gets **401** on `/mcp`.

### Better Auth JWT / `jwkss`

A **500** with *Failed to decrypt private key*: see [`.ai/agents/backend-jwks-recovery.md`](../../.ai/agents/backend-jwks-recovery.md).
