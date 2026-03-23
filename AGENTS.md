## Where agent instructions live

Agent instructions are **distributed**: this file covers repo-wide rules; apps and packages can have their own `AGENTS.md` with local instructions. When working in an app or package, read both the root AGENTS.md and that folder's AGENTS.md (if present).

- **Root** (this file): architecture, code style.
- **apps/backend**: [apps/backend/AGENTS.md](apps/backend/AGENTS.md) — API, OpenAPI, MCP, Drizzle, TypeScript, etc.
- **apps/otel-collector**: OpenTelemetry Collector for Better Stack + LangFuse; config + `.env` in `apps/otel-collector/`.
- **apps/codesearch**: [apps/codesearch/AGENTS.md](apps/codesearch/AGENTS.md) — Zoekt orchestration, read-only DB, OpenAPI + Zod.
- **apps/ui**: [apps/ui/AGENTS.md](apps/ui/AGENTS.md) — TanStack Start frontend, React Aria, Tailwind, Storybook, Vitest.
- **apps/docs**: [apps/docs/AGENTS.md](apps/docs/AGENTS.md) — Fumadocs documentation site (Next.js 15, Shiki, forced-dark, deploys to docs.ctxpipe.ai).

**Host dev (agents):** Run **`pnpm`** from the repo root; follow **Agent runbook — host dev** under [Local development](#local-development) (install → `.env.local` → `dev:infra` → `dev`).

**When feedback is given that should become a long-term instruction**: Save it into this structure. Repo-wide preferences and conventions go in this file (root AGENTS.md). Instructions that apply only to a specific app or package go in that folder's `AGENTS.md` (e.g. `apps/backend/AGENTS.md`); create the file if it doesn't exist. Add or update the list above when you create or change an app/package AGENTS.md so future agents know where to look.

## Architecture decisions & ADRs

- **Where ADRs live**: All ADRs are in **ConKeeper memory**: `.ai/memory/decisions/`. Files are named `ADR-NNN-title-slug.md` (e.g. `ADR-001-frontend-ui-app-stack.md`).
- **When you change architecture**: Before making structural or architectural changes (adding/changing apps, packages, tooling, or cross-cutting patterns), read the relevant ADRs in `.ai/memory/decisions/` first.
- **Keeping ADRs up to date**: When you make a new architectural decision, use `memory-sync` skill to update ConKeeper memory.
- **Agent workflow**: Treat ADRs as the source of truth for high-level decisions. If the code and ADRs disagree, prefer updating the ADRs (and then the code) so future agents can follow a consistent story.

## Local development

- **Docker Compose**: Single [docker-compose.yml](docker-compose.yml) uses **profiles** (see [.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md](.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md)). **`pnpm dev:infra`** runs `docker compose --profile infra up -d` (Postgres, FalkorDB, OTEL, standalone Zoekt only). **`pnpm start`** runs `docker compose --profile deploy up -d` (production images: migrate, backend, worker, UI, codesearch). For day-to-day coding, apps still run on the host via **`pnpm dev`** (portless + Turbo). Override host ports via **`CTXPIPE_*`** — [docker-compose.env.example](docker-compose.env.example).

### Agent runbook — host dev (run from repo root)

Run **`pnpm`** commands from the **repository root** (not inside `apps/*`).

1. **`pnpm install`**
2. **`apps/backend/.env.local`**: copy from [apps/backend/.env.example](apps/backend/.env.example) if missing. Set **`AUTH_SECRET`** (≥ 32 characters). Set **`DATABASE_URL`** / **`GRAPH_DB_URI`** as in the example (Postgres default **5433** on host, FalkorDB **`redis://localhost:6379`** when infra is up). **Linked git worktree**: use a **`DATABASE_URL`** whose database name is the per-worktree DB ([`scripts/worktree-db.sh`](scripts/worktree-db.sh) creates `ctxpipe_<sanitized_branch>`; match that name so **`pnpm dev`** and backend match migrate). **Normal clone**: default database name **`ctxpipe`** is enough.
3. **`pnpm dev:infra`** — Docker must be running. Starts Postgres, FalkorDB, otel-collector, zoekt-webserver (Compose **`infra`** profile only).
4. **`pnpm dev`** — Starts the portless HTTPS proxy, exports **`AUTH_BASE_URL`**, **`UI_PROXY_URL`**, **`CODESEARCH_URL`**, **`VITE_PUBLIC_API_URL`**, and **`AUTH_ALLOWED_ORIGINS`** via **`portless get`** (backend/API + public app origin: **`app.ctxpipe`**; UI and codesearch use separate internal **`portless get`** targets—see [`scripts/dev-apps.sh`](scripts/dev-apps.sh)), then Turbo runs backend **`migrate`** first (see below), then backend + UI + codesearch. **Browse and test the integrated UI + API at the `app.ctxpipe` origin** (HTTPS via portless), not **`ui.ctxpipe`** or raw localhost ports. Worktree prefixes follow [portless](https://port1355.dev/) (branch subdomain on linked worktrees). Trust the dev CA once: **`node_modules/.bin/portless trust`** from the repo root, or **`portless trust`** with a global install per [portless docs](https://port1355.dev/). Avoid **`pnpm exec portless`** (blocked by portless).

**Migrations only** (no dev servers): **`pnpm db:migrate`** from repo root.

**How migrate picks `DATABASE_URL`**: [`apps/backend/package.json`](apps/backend/package.json) **`db:migrate`** runs **`source ../../scripts/worktree-db.sh`** then **`drizzle-kit migrate`**. In a **linked** worktree, the script creates the DB if needed and **`export`s `DATABASE_URL` in that shell** (no `.env` edits). That requires **`psql`** on `PATH` to talk to Postgres. In a **normal** checkout, the script does nothing to the shell; Drizzle uses **`DATABASE_URL`** from `.env.local` / defaults.

**Direct script** (optional): **`eval "$(./scripts/worktree-db.sh)"`** sets `DATABASE_URL` in the **current** shell (script prints `export …` when run with `bash`, not `source`).

**Codesearch on host**: if you change **`CTXPIPE_ZOEKT_HOST_PORT`**, set **`ZOEKT_WEBSERVER_URL`** in `apps/codesearch/.env.local` (e.g. `http://127.0.0.1:<port>`). See [README.md](README.md).

### Container deploy (Compose `deploy` profile)

From the repo root, set **`AUTH_SECRET`** (≥ 32 characters), **`AUTH_BASE_URL`**, **`CTXPIPE_PUBLIC_APP_URL`** (usually the public origin users use for the API / app), and optionally **`AUTH_ALLOWED_ORIGINS`** in a root **`.env`** next to [docker-compose.yml](docker-compose.yml) — see [docker-compose.env.example](docker-compose.env.example). Then run **`pnpm start`** (builds images on first run). TLS and a reverse proxy in front of published ports are left to the operator. Better Auth schema upgrades may require **`pnpm --filter @ctxpipe/backend auth:migrate`** against the same database when upgrading.

## Parallel worktrees and coding agents

Use **one shared Postgres** on the host (default **5433**) and **one database per linked worktree**. CI uses its own DB (default name **`ctxpipe`**); see [.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md](.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md).

1. **Port conflicts**: Copy [docker-compose.env.example](docker-compose.env.example) → `.env` at repo root; assign a fresh **`CTXPIPE_*`** block if ports clash (Postgres can stay on **5433** if only one Compose stack runs).
2. **HTTP / [portless](https://github.com/vercel-labs/portless)**: Host dev uses **`pnpm dev`** so env matches **`portless get`** (public app/API origin **`app.ctxpipe`**; internal UI and codesearch URLs via **`UI_PROXY_URL`** / **`CODESEARCH_URL`**). The **browser entrypoint for the product is always `app.ctxpipe`**, not **`ui.ctxpipe`** or localhost. Per-process **`PORTLESS_URL`** is still set by portless for each child.
3. **`.cursor` → `.agents`**: In this repo, **`.cursor` is a symlink to `.agents`** (same files on disk). [Cursor parallel worktrees](https://cursor.com/docs/configuration/worktrees) read **`worktrees.json`** at **`.cursor/worktrees.json`** — that file contains **only** Cursor’s `setup-worktree` keys (see [`worktrees.json`](.agents/worktrees.json): `pnpm install` and `pnpm db:migrate`). Copy **`apps/backend/.env.local`** from your primary checkout or from [`.env.example`](apps/backend/.env.example) if the new worktree needs secrets; that is not automated. **Local ports and URLs** for dev and MCP follow this runbook, [docker-compose.env.example](docker-compose.env.example), and [apps/backend/.env.example](apps/backend/.env.example) (use **`portless get app.ctxpipe`** for HTTPS in host dev, not raw localhost guesses).

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
