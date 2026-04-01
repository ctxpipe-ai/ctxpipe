# ctxpipe app

**The context layer for AI agents** — infrastructure that helps coding agents understand your codebase, standards, and how work gets done in your org. Git-first instruction hierarchy (`AGENTS.md`, skills, MCP), a knowledge graph that learns from your repo and usage, and an agent-agnostic **MCP** surface so Cursor, Claude Code, Copilot, and other tools share one connection.

Learn more on **[ctxpipe.ai](https://www.ctxpipe.ai/)**.

## Documentation

- **[docs.ctxpipe.ai](https://docs.ctxpipe.ai)** — guides and reference
- **[Quickstart](https://docs.ctxpipe.ai/docs/quickstart)** · **[Self-hosting](https://docs.ctxpipe.ai/docs/self-hosting)** · **[MCP](https://docs.ctxpipe.ai/docs/mcp)**

## Local development (quick start)

**Requirements:** Node.js 22+, pnpm 10, Docker with Compose v2 (Docker also runs the **codesearch** service during `pnpm dev` with a random host port).

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env.local
# Set AUTH_SECRET (≥ 32 characters) in apps/backend/.env.local

pnpm dev:infra
pnpm dev
```

**Recommended local flow:**

1. Run **`pnpm dev:infra`** once to start Postgres, FalkorDB, and OTEL in Docker
2. Run **`pnpm dev`** — starts portless, builds/runs the **codesearch** Docker image ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh)), then backend + UI on the host
3. Open **`https://app.ctxpipe.localhost:1355`** to access the app

> [!info]
> If you use **linked git worktrees**, your URL will be prefixed by worktree name; see [portless](https://port1355.dev/) for how that works.

> [!warning]
> If your browser warns about the certificate, run **`pnpm trust`** once from the repo root.

For API details, OpenAPI, and MCP: [apps/backend/README.md](apps/backend/README.md).

## Self-hosted stack (Docker Compose)

For a small-scale deployment with production images (backend, UI, codesearch, worker), copy [docker-compose.env.example](docker-compose.env.example) to `.env` at the repo root, set **`AUTH_SECRET`**, **`AUTH_BASE_URL`**, and **`CTXPIPE_PUBLIC_APP_URL`**, then run **`pnpm start`**. See [.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md](.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md) and root [AGENTS.md](AGENTS.md).

## Scripts

| Command                     | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev:infra`            | Start Docker-backed dependencies for local development (Compose `infra` profile) |
| `pnpm start`                | Build (if needed) and run the full containerized stack (Compose `deploy` profile) |
| `pnpm dev`                  | Run backend + UI on the host; codesearch in Docker ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh)); migrations run first |
| `pnpm db:migrate`           | Run backend database migrations                                              |
| `pnpm dev:backend`          | Backend only on the host (e.g. extra worktree); configure env as needed      |
| `pnpm build`                | Turborepo build                                                              |
| `pnpm lint` / `pnpm format` | Biome                                                                        |
| `pnpm mcp:inspect`          | MCP inspector (backend)                                                      |
