# ctxpipe

**The context layer for AI agents** — infrastructure that helps coding agents understand your codebase, standards, and how work gets done in your org. Git-first instruction hierarchy (`AGENTS.md`, skills, MCP), a knowledge graph that learns from your repo and usage, and an agent-agnostic **MCP** surface so Cursor, Claude Code, Copilot, and other tools share one connection.

Learn more on **[ctxpipe.ai](https://www.ctxpipe.ai/)**.

## Documentation

- **[docs.ctxpipe.ai](https://docs.ctxpipe.ai)** — guides and reference  
- **[Quickstart](https://docs.ctxpipe.ai/docs/quickstart)** · **[Self-hosting](https://docs.ctxpipe.ai/docs/self-hosting)** · **[MCP](https://docs.ctxpipe.ai/docs/mcp)**

## Local development (quick start)

**Requirements:** Node.js 22+, pnpm 10, Docker with Compose v2.

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env.local
# Set AUTH_SECRET (≥ 32 characters) in apps/backend/.env.local

pnpm dev:infra
pnpm dev:apps
```

**Recommended local flow:** **`pnpm dev:infra`** starts supporting services in Docker once. **`pnpm dev:apps`** runs the backend, UI, and codesearch through **[portless](https://github.com/vercel-labs/portless)** (HTTPS at the proxy; Bun serves plain HTTP). Routes use **`api.ctxpipe`**, **`app.ctxpipe`**, and **`search.ctxpipe`** on the default **`.localhost`** TLD (see [portless docs](https://port1355.dev/)). In a **linked git worktree**, portless prepends the current **branch** as a subdomain (e.g. `https://feature-x.api.ctxpipe.localhost:1355` on branch `feature-x`). Trust the dev CA once: **`node_modules/.bin/portless trust`** from the repo root (or **`portless trust`** if you installed portless globally, as in the [portless docs](https://port1355.dev/)). Do not use **`pnpm exec portless`** — portless blocks that; use the bin path above or a global install. If ports clash with other software, copy [docker-compose.env.example](docker-compose.env.example) to `.env` at the repo root and adjust the host port variables.

**Full stack in Docker:** **`pnpm dev`** or **`pnpm dev:docker`** runs the whole stack in containers. Use this instead of host-run apps when you prefer everything inside Compose.

For API details, OpenAPI, and MCP: [apps/backend/README.md](apps/backend/README.md).

### Parallel git worktrees

Multiple checkouts can share one local Postgres and use **a separate database per worktree**. See [AGENTS.md](AGENTS.md) and [.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md](.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md).

## Scripts

| Command | Purpose |
| ------- | ------- |
| `pnpm dev:infra` | Start Docker-backed dependencies for local development |
| `pnpm dev:apps` | Run backend, UI, and codesearch via portless (see above; migrations first) |
| `pnpm db:migrate` | Run backend database migrations |
| `pnpm dev` / `pnpm dev:docker` | Run the full stack in Docker (`docker compose up`) |
| `pnpm dev:backend` | Backend only on the host (e.g. extra worktree); configure env as needed |
| `pnpm build` | Turborepo build |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm mcp:inspect` | MCP inspector (backend) |
