# `@ctxpipe/backend`

Core HTTP API and MCP service for [ctxpipe](https://ctxpipe.ai). Built with **Hono** on **Bun**, **Better Auth**, **PostgreSQL** + **Drizzle**, and workflow orchestration for ingestion and agent tooling.

**Monorepo:** clone, environment, Compose deployment, and host dev flows live in the [repository root README](../../README.md). Run **`pnpm dev:infra`** and **`pnpm dev`** from the repo root unless you are intentionally running only this package.

## What this package provides

- org-scoped REST APIs (`/:orgSlug/api/v1/*`)
- MCP endpoint (`/mcp`) for agent integrations
- repository indexing, and ingestion v2 (sandbox skills that write patches) for context extraction
- authentication and organisation access control

## Stack

- Runtime: Bun (container/runtime target)
- HTTP: Hono
- API contracts: `@hono/zod-openapi` + Zod
- Auth: Better Auth
- DB: PostgreSQL + Drizzle ORM
- Orchestration: OpenWorkflow
- Testing: Vitest

## API & endpoints

- REST (org-scoped): `/:orgSlug/api/v1/*`
- OpenAPI JSON: `/.docs/openapi`
- API reference UI (Scalar): `/.docs/api-reference`
- MCP endpoint: `/mcp?orgSlug=<slug>`
- Status: `/.status`

## Diagnose MCP

Use the official MCP Inspector (`@modelcontextprotocol/inspector`) as the
diagnostic client. It is not part of the backend runtime. Use it with a
**test** organization only.

For host development, start ctxpipe and target the org-scoped endpoint:

```bash
pnpm dev:infra
pnpm dev

export MCP_URL="https://app.ctxpipe.localhost/mcp?orgSlug=<slug>"
export NODE_EXTRA_CA_CERTS="$HOME/.portless/ca.pem"
npx @modelcontextprotocol/inspector@2.16.0
```

In the Inspector, select the Streamable HTTP transport, enter `$MCP_URL`, and
connect. The Inspector shows the OAuth flow, `tools/list`, and each JSON-RPC
message.

`pnpm trust` puts the Portless CA into the system trust store, but a separate
Node.js CLI can still need `NODE_EXTRA_CA_CERTS`. If that file does not exist,
find the CA path in the Portless output. Do not disable TLS verification.

When a failure occurs again, find the backend `step=mcp.request` event at the
same time and JSON-RPC method. Then find the `mcp.tool <name>` span of the call
in HyperDX by its call id. OAuth endpoint failures use
`step=oauth.endpoint_error`.

## Webhooks (GitHub App)

- Endpoint: `POST /api/v1/webhook/github`
- HMAC verification via `GITHUB_WEBHOOK_SECRET`
- `push` events to the default branch trigger repository indexing (with UI “indexing recent changes”). Ingestion v2 publishes at Workspace format 3 or more; below format 3 no ingestion runs
- `repository.created` can trigger repository sync when auto-sync options are enabled

The GitHub App must be subscribed to `push` webhook events on connected repositories for re-indexing to fire on merge / direct push. `pull_request` events are intentionally not a fallback — they don't cover direct pushes to the default branch (hotfixes, incident response).

For **local development**, GitHub cannot deliver webhooks to `localhost`; use an HTTPS tunnel (for example Cloudflare Tunnel, ngrok, or Tailscale Funnel), register the forwarded URL with your GitHub App, and ensure it reaches `POST …/api/v1/webhook/github`.

## Contract tests

Run `pnpm test:contracts` with `DATABASE_URL`, `AUTH_SECRET`, and `CLICKHOUSE_URL` pointing to disposable development services. The lane checks PostgreSQL, ClickHouse, Git, Bun, OpenCode, Zoekt and ast-grep before executing contracts; missing prerequisites fail the run. The ClickHouse user in `CLICKHOUSE_URL` must have SQL access management, because the knowledge store contracts make their own users.

## Scripts (this package)

| Script | Description |
| --- | --- |
| `pnpm dev` | Run backend + worker in dev |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run built server |
| `pnpm test` | Run test suite |
| `pnpm lint` | Run Oxlint (from the repository root) |
| `pnpm format` | Run Oxfmt (from the repository root) |
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

## Licence

Released under the **MIT License**, the same terms as the parent repo. Details: [open-source (docs)](https://docs.ctxpipe.ai/docs/resources/open-source).
