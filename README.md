<p align="center">
  <img src="apps/ui/public/ctx_.svg" alt="ctx|" width="320" />
</p>

<p align="center">
  <a href="https://img.shields.io/badge/License-ELv2-0f766e.svg"><img src="https://img.shields.io/badge/License-ELv2-0f766e.svg" alt="License: ELv2" /></a>
</p>

<p align="center">
  <a href="https://ctxpipe.ai">Website</a>
  ·
  <a href="https://github.com/ctxpipe-ai/ctxpipe/issues">Issues</a>
  ·
  <a href="https://docs.ctxpipe.ai">Docs</a>
</p>

# ctx| (ctxpipe)

**The context layer for AI agents** — infrastructure that helps coding agents understand your codebase, standards, and how work gets done in your organisation. ctx| combines a Git-first instruction hierarchy (`AGENTS.md`, skills, MCP), a knowledge graph that learns from your repositories and usage, and an agent-agnostic MCP surface so Cursor, Claude Code, Copilot, and other tools can share one connection.

Learn more at **[ctxpipe.ai](https://ctxpipe.ai)**.

## How it fits together

<p align="center">
  <img src="apps/ui/public/images/ctxpipe-onboarding-diagram.svg" alt="ctx| diagram" width="1080" />
</p>

## Documentation

- **[docs.ctxpipe.ai](https://docs.ctxpipe.ai)** — product guides and technical reference
- **[Getting started](https://docs.ctxpipe.ai/docs/getting-started)** · **[MCP](https://docs.ctxpipe.ai/docs/mcp/mcp-docs)**
- **MCP setup from the terminal:** `npx ctxpipe init` (see [packages/cli/README.md](packages/cli/README.md) and `npx ctxpipe init --help`)

## Local development (quick start)

**Requirements:** Node.js 22+, pnpm 10, Docker with Compose v2.  
Docker also runs the **codesearch** service during `pnpm dev` (random host port).

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env.local
# Set AUTH_SECRET (≥ 32 characters) in apps/backend/.env.local

pnpm dev:infra
pnpm dev
```

**Recommended flow:**

1. Run **`pnpm dev:infra`** once to start Postgres, FalkorDB, and OTEL in Docker
2. Run **`pnpm dev`** — starts portless, builds/runs codesearch in Docker ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh)), then runs backend + UI on host
3. Open **`https://app.ctxpipe.localhost`** to access the app

> [!info]
> If you use linked git worktrees, your URL is prefixed by worktree name. See [portless](https://portless.sh/) for behaviour details.

> [!warning]
> If your browser warns about the local certificate, run **`pnpm trust`** once from the repo root.

For backend API, OpenAPI, MCP, and package scripts, see [apps/backend/README.md](apps/backend/README.md).

## Cursor Cloud and headless VMs

Portless (`pnpm dev`) is not usable on typical remote agent machines. **Default stack for agents:** follow **Running dev servers on cloud VMs** in the root [AGENTS.md](AGENTS.md) (infra → migrate → Bun backend on port 3000 → Vite on 3002 → open **http://localhost:3000**). That page also covers `sudo docker compose` when the Docker socket is not writable and notes on OTLP noise and codesearch.

## Self-hosted stack (Docker Compose)

For small-scale self-hosted deployment with production images (backend, UI, codesearch, worker):

1. Copy [docker-compose.env.example](docker-compose.env.example) to `.env` at repo root
2. Set **`AUTH_SECRET`**, **`AUTH_BASE_URL`**, and **`CTXPIPE_PUBLIC_APP_URL`**
3. Run **`pnpm start`**

See [.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md](.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md) and [AGENTS.md](AGENTS.md) for operational details.

## Scripts

| Command                     | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev:infra`            | Start Docker-backed dependencies for local development (Compose `infra` profile) |
| `pnpm start`                | Build (if needed) and run the full containerized stack (Compose `deploy` profile) |
| `pnpm dev`                  | Run backend + UI on host; codesearch in Docker ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh)); migrations run first |
| `pnpm db:migrate`           | Run backend database migrations                                              |
| `pnpm dev:backend`          | Backend only on the host (e.g. extra worktree); configure env as needed      |
| `pnpm build`                | Turborepo build                                                              |
| `pnpm lint` / `pnpm format` | Biome                                                                        |
| `pnpm mcp:inspect`          | MCP inspector (backend)                                                      |

## Licence

This project is released under **Elastic License 2.0 (ELv2)**.  
See the open-source guide: [docs.ctxpipe.ai/docs/resources/open-source](https://docs.ctxpipe.ai/docs/resources/open-source)
