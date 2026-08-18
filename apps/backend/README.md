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

## Diagnose MCP with MCPJam

MCPJam is a **diagnostic client**, not part of the backend runtime and not a
ctx| product feature. Use it to exercise OAuth and tools against a **test**
organisation. Keep the official `pnpm mcp:inspect` workflow as an independent
protocol reference.

**In scope:** interactive DCR OAuth, `tools/list`, a test `ctx_advisor` call,
protocol conformance (CI), and a visual Inspector for local HTTP(S).

**Out of scope:** tenant isolation, token refresh races, dropped-session
recovery, concurrent clients, customer orgs, and CI gates on interactive OAuth
or LLM evals.

For host development, start ctxpipe normally and target the exact org-scoped
endpoint:

```bash
pnpm dev:infra
pnpm dev

export MCP_URL="https://app.ctxpipe.localhost/mcp?orgSlug=<slug>"
export NODE_EXTRA_CA_CERTS="$HOME/.portless/ca.pem"
```

Portless installs its CA into the system trust store with `pnpm trust`, but a
separate Node.js CLI may still require `NODE_EXTRA_CA_CERTS`. If that file does
not exist, inspect the Portless output for its CA path rather than disabling TLS
verification.

Start broad and narrow the failure:

```bash
# 1. Reachability, transport selection, 401 challenge, and OAuth discovery
pnpm mcpjam:doctor --url "$MCP_URL" --out .mcpjam/doctor-unauthenticated.json

# 2. Run interactive DCR OAuth and retain redacted HTTP diagnostics
pnpm mcpjam:login \
  --url "$MCP_URL" \
  --protocol-version 2025-11-25 \
  --registration dcr \
  --credentials-out .mcpjam/credentials.json \
  --debug-out .mcpjam/oauth-debug.json

# 3. Retry the complete MCP sweep with refreshable credentials
pnpm mcpjam:doctor \
  --url "$MCP_URL" \
  --credentials-file .mcpjam/credentials.json \
  --out .mcpjam/doctor-authenticated.json

# 4. Exercise the deterministic tool surface
pnpm mcpjam:tools list \
  --url "$MCP_URL" \
  --credentials-file .mcpjam/credentials.json
```

For the visual OAuth and JSON-RPC timeline:

```bash
pnpm mcpjam:inspect \
  --url "$MCP_URL" \
  --name "ctxpipe local" \
  --oauth \
  --tab servers
```

Use the local MCPJam Inspector for `*.localhost`. The hosted MCPJam application
cannot reach a local endpoint or refresh tokens against a local authorisation
server. For `https://app.ctxpipe.ai/mcp?orgSlug=<slug>`, use a test organisation
and a test user; do not expose customer tool results or reusable credentials to
a third-party hosted project.

When a failure reproduces, correlate the MCPJam timestamp and JSON-RPC method
with the backend's `step=mcp.request` event in Railway logs, then use the
resulting advisor thread in Langfuse for model/tool execution details. OAuth
endpoint failures use `step=oauth.endpoint_error`. Files under `.mcpjam/` are
gitignored, but they can still contain operational details: review them before
sharing.

## Webhooks (GitHub App)

- Endpoint: `POST /api/v1/webhook/github`
- HMAC verification via `GITHUB_WEBHOOK_SECRET`
- `push` events to the default branch trigger repository ingestion (with UI “indexing recent changes”)
- `repository.created` can trigger repository sync when auto-sync options are enabled

The GitHub App must be subscribed to `push` webhook events on connected repositories for re-indexing to fire on merge / direct push. `pull_request` events are intentionally not a fallback — they don't cover direct pushes to the default branch (hotfixes, incident response).

For **local development**, GitHub cannot deliver webhooks to `localhost`; use an HTTPS tunnel (for example Cloudflare Tunnel, ngrok, or Tailscale Funnel), register the forwarded URL with your GitHub App, and ensure it reaches `POST …/api/v1/webhook/github`.

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
