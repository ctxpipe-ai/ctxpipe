## Where agent instructions live

Agent instructions are **distributed**: this file covers repo-wide rules; apps and packages can have their own `AGENTS.md` with local instructions. When working in an app or package, read both the root AGENTS.md and that folder's AGENTS.md (if present).

- **Root** (this file): architecture, code style.
- **apps/backend**: [apps/backend/AGENTS.md](apps/backend/AGENTS.md) — API, OpenAPI, MCP, Drizzle, TypeScript, etc.
- **apps/otel-collector**: OpenTelemetry Collector for Better Stack + LangFuse; config + `.env` in `apps/otel-collector/`.
- **apps/codesearch**: [apps/codesearch/AGENTS.md](apps/codesearch/AGENTS.md) — Zoekt orchestration, read-only DB, OpenAPI + Zod.
- **apps/ui**: [apps/ui/AGENTS.md](apps/ui/AGENTS.md) — TanStack Start frontend, React Aria, Tailwind, Storybook, Vitest.
- **apps/docs**: [apps/docs/AGENTS.md](apps/docs/AGENTS.md) — Fumadocs documentation site (Next.js 15, Shiki, forced-dark, deploys to docs.ctxpipe.ai).

**Host dev (agents):** Run **`pnpm`** from the repo root; follow **Agent runbook — host dev** under [Local development](#local-development) (install → `.env.local` → `dev:infra` → `dev:apps`).

**When feedback is given that should become a long-term instruction**: Save it into this structure. Repo-wide preferences and conventions go in this file (root AGENTS.md). Instructions that apply only to a specific app or package go in that folder's `AGENTS.md` (e.g. `apps/backend/AGENTS.md`); create the file if it doesn't exist. Add or update the list above when you create or change an app/package AGENTS.md so future agents know where to look.

## Architecture decisions & ADRs

- **Where ADRs live**: All ADRs are in **ConKeeper memory**: `.ai/memory/decisions/`. Files are named `ADR-NNN-title-slug.md` (e.g. `ADR-001-frontend-ui-app-stack.md`).
- **When you change architecture**: Before making structural or architectural changes (adding/changing apps, packages, tooling, or cross-cutting patterns), read the relevant ADRs in `.ai/memory/decisions/` first.
- **Keeping ADRs up to date**: When you make a new architectural decision, use `memory-sync` skill to update ConKeeper memory.
- **Agent workflow**: Treat ADRs as the source of truth for high-level decisions. If the code and ADRs disagree, prefer updating the ADRs (and then the code) so future agents can follow a consistent story.

## Local development

- **Root `pnpm dev` / `pnpm dev:docker`**: **`docker compose up`** — full stack in containers. Does not use Turbo for host dev servers. See [apps/backend/AGENTS.md](apps/backend/AGENTS.md) and [.ai/memory/decisions/ADR-004-local-development-docker-compose.md](.ai/memory/decisions/ADR-004-local-development-docker-compose.md).
- **Docker Compose**: Single [docker-compose.yml](docker-compose.yml): Postgres, FalkorDB, backend (Bun, default **3000**), UI (**3002**), codesearch (**3001**), Zoekt (**6070** on host when using `dev:infra`). Override host ports via **`CTXPIPE_*`** — [docker-compose.env.example](docker-compose.env.example).
- **Node modules cleanup (one-time)**: If containerized installs fail with workspace package read errors, remove `apps/*/node_modules` once and restart Compose.

### Agent runbook — host dev (run from repo root)

Run **`pnpm`** commands from the **repository root** (not inside `apps/*`).

1. **`pnpm install`**
2. **`apps/backend/.env.local`**: copy from [apps/backend/.env.example](apps/backend/.env.example) if missing. Set **`AUTH_SECRET`** (≥ 32 characters). Set **`DATABASE_URL`** / **`GRAPH_DB_URI`** as in the example (Postgres default **5433** on host, FalkorDB **`redis://localhost:6379`** when infra is up). **Linked git worktree**: use a **`DATABASE_URL`** whose database name is the per-worktree DB ([`scripts/worktree-db.sh`](scripts/worktree-db.sh) creates `ctxpipe_<sanitized_branch>`; match that name so **`pnpm dev:apps`** and backend match migrate). **Normal clone**: default database name **`ctxpipe`** is enough.
3. **`pnpm dev:infra`** — Docker must be running. Starts Postgres, FalkorDB, otel-collector, zoekt-webserver.
4. **`pnpm dev:apps`** — Starts the portless HTTPS proxy, exports **`AUTH_BASE_URL`**, **`UI_PROXY_URL`**, **`CODESEARCH_URL`**, **`VITE_PUBLIC_API_URL`**, and **`AUTH_ALLOWED_ORIGINS`** via **`portless get`** (same hostnames as **`portless api.ctxpipe` / `app.ctxpipe` / `search.ctxpipe`**), then Turbo runs backend **`migrate`** first (see below), then backend + UI + codesearch. Worktree prefixes follow [portless](https://port1355.dev/) (branch subdomain on linked worktrees). Trust the dev CA once: **`node_modules/.bin/portless trust`** from the repo root, or **`portless trust`** with a global install per [portless docs](https://port1355.dev/). Avoid **`pnpm exec portless`** (blocked by portless).

**Migrations only** (no dev servers): **`pnpm db:migrate`** from repo root.

**How migrate picks `DATABASE_URL`**: [`apps/backend/package.json`](apps/backend/package.json) **`db:migrate`** runs **`source ../../scripts/worktree-db.sh`** then **`drizzle-kit migrate`**. In a **linked** worktree, the script creates the DB if needed and **`export`s `DATABASE_URL` in that shell** (no `.env` edits). That requires **`psql`** on `PATH` to talk to Postgres. In a **normal** checkout, the script does nothing to the shell; Drizzle uses **`DATABASE_URL`** from `.env.local` / defaults.

**Direct script** (optional): **`eval "$(./scripts/worktree-db.sh)"`** sets `DATABASE_URL` in the **current** shell (script prints `export …` when run with `bash`, not `source`).

**Codesearch on host**: if you change **`CTXPIPE_ZOEKT_HOST_PORT`**, set **`ZOEKT_WEBSERVER_URL`** in `apps/codesearch/.env.local` (e.g. `http://127.0.0.1:<port>`). See [README.md](README.md).

## Parallel worktrees and coding agents

Use **one shared Postgres** on the host (default **5433**) and **one database per linked worktree**. CI uses its own DB (default name **`ctxpipe`**); see [.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md](.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md).

1. **Port conflicts**: Copy [docker-compose.env.example](docker-compose.env.example) → `.env` at repo root; assign a fresh **`CTXPIPE_*`** block if ports clash (Postgres can stay on **5433** if only one Compose stack runs).
2. **HTTP / [portless](https://github.com/vercel-labs/portless)**: Host dev uses **`pnpm dev:apps`** so **`AUTH_BASE_URL`**, **`UI_PROXY_URL`**, **`CODESEARCH_URL`**, **`AUTH_ALLOWED_ORIGINS`**, and **`VITE_PUBLIC_API_URL`** match **`portless get`** for **`api.ctxpipe`**, **`app.ctxpipe`**, and **`search.ctxpipe`**. Per-process **`PORTLESS_URL`** is still set by portless for each child.
3. **Agent-facing URLs**: [.agents/worktrees.json](.agents/worktrees.json) — defaults match Compose. Optional **`.agents/worktrees.local.json`** (gitignored) for overrides.

## Code style

- **Avoid pulling to globals**: Do not extract config or one-off values to module/global scope unless they are reused in more than one place. Inline them where they are used.
- **Environment variables**: Use only for values that differ by **environment** or that **operators/customers must set** (secrets, base URLs, infra limits). Do not use env for **feature toggles** or **internal logic**; keep those in code or committed config. See [.ai/memory/patterns.md](.ai/memory/patterns.md) (Code conventions).

<!-- ConKeeper Memory System -->

## Memory System

This project uses ConKeeper for persistent AI context management.

**Memory Location:** All memory related to this project is in `.ai/memory/`.

**Start here:** [.ai/memory/README.md](.ai/memory/README.md) — what each file is for, **default read order** (gradual discovery / small context load), and write rules.

**Available Workflows:** Use the following skills to build and query project memory.

- **memory-init** - Initialize memory for this project
- **memory-sync** - Sync session state to memory files
- **session-handoff** - Generate handoff for new session
- **memory-search** - Search memory files by keyword or category
- **memory-reflect** - Session retrospection and improvement analysis
- **memory-insights** - Session friction trends and success pattern analysis

**Memory Files:**

- `active-context.md` - Context of the work in progress
- `product-context.md` - Project overview
- `progress.md` - Progress of current tasks being worked on. Update when you need to compact the conversations
- `decisions/` - Architecture Decision Records
- `sessions/` - Session summaries

**Usage:**
- For non-trivial tasks: staged load per [.ai/memory/README.md](.ai/memory/README.md) (README → decisions index → relevant product-context sections → **one** patterns topic → ADRs on demand). Use `memory-search` to avoid loading all of `patterns.md`.
- **Proactively sync memory** (use the `memory-sync` skill) whenever any of these happen during a conversation:
  - An architectural or tooling decision is made (e.g. switching API styles, adding infra, enabling strict mode)
  - The user corrects the agent or gives feedback on what it got wrong
  - The user states a preference or convention/pattern (naming, style, workflow)
  - The user shares project context not inferable from code (personas, SLAs, a11y standards, compliance, team structure, roadmap)
  - A significant milestone is reached (feature complete, migration done)
- **Do not wait for the user to ask** — if any trigger above fires, read and follow the `memory-sync` skill immediately (Tier A auto-writes apply without confirmation; ADRs and substantive `product-context` changes need approval unless the user said `memory: auto`).
- Use handoff when context window fills

For full documentation: https://github.com/swannysec/context-keeper
<!-- /ConKeeper -->
