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
pnpm dev
```

**Recommended local flow:**

1. Run **`pnpm dev:infra`** once to start supporting services in Docker
2. Run **`pnpm dev`** to start dev server
3. Open **`https://app.ctxpipe.localhost:1355`** to access the app

> [!info]
> If you use **linked git worktrees**, your URL will be prefixed by worktree name; see [portless](https://port1355.dev/) for how that works.

> [!warning]
> If your browser warns about the certificate, run **`pnpm trust`** once from the repo root.

For API details, OpenAPI, and MCP: [apps/backend/README.md](apps/backend/README.md).

## Scripts

| Command                     | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev:infra`            | Start Docker-backed dependencies for local development                       |
| `pnpm dev`                  | Run backend, UI, and codesearch for local development (migrations run first) |
| `pnpm db:migrate`           | Run backend database migrations                                              |
| `pnpm dev:backend`          | Backend only on the host (e.g. extra worktree); configure env as needed      |
| `pnpm build`                | Turborepo build                                                              |
| `pnpm lint` / `pnpm format` | Biome                                                                        |
| `pnpm mcp:inspect`          | MCP inspector (backend)                                                      |
