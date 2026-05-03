## Where agent instructions live

Agent instructions are **distributed**: this file covers repo-wide rules; apps and packages can have their own `AGENTS.md` with local instructions. When working in an app or package, read both the root AGENTS.md and that folder's AGENTS.md (if present).

- **Root** (this file): architecture, code style.
- **apps/backend**: [apps/backend/AGENTS.md](apps/backend/AGENTS.md) — API, OpenAPI, MCP, Drizzle, TypeScript, etc.
- **apps/otel-collector**: OpenTelemetry Collector for Better Stack + LangFuse; config + `.env` in `apps/otel-collector/`.
- **apps/codesearch**: [apps/codesearch/AGENTS.md](apps/codesearch/AGENTS.md) — Zoekt orchestration, read-only DB, OpenAPI + Zod.
- **apps/ui**: [apps/ui/AGENTS.md](apps/ui/AGENTS.md) — TanStack Start frontend, React Aria, Tailwind, Storybook, Vitest.
- **apps/docs**: [apps/docs/AGENTS.md](apps/docs/AGENTS.md) — Fumadocs documentation site (Next.js 15, Shiki, forced-dark, deploys to docs.ctxpipe.ai).

**MCP (project-scoped):** [.agents/mcp.json](.agents/mcp.json) includes the backend and **Storybook** (server `ctxpipe-storybook` at `http://127.0.0.1:6006/mcp` when Storybook is running; start with `pnpm --filter @ctxpipe/ui storybook`). For story conventions, component-vs-page patterns, and how to use the Storybook tools, read [.agents/skills/storybook/SKILL.md](.agents/skills/storybook/SKILL.md) together with [apps/ui/AGENTS.md](apps/ui/AGENTS.md).

**Host dev (agents):** Run **`pnpm`** from the repo root; follow **Agent runbook — host dev** under [Local development](#local-development) (install → `.env.local` → `dev:infra` → `dev`).

**When feedback is given that should become a long-term instruction**: Save it into this structure. Repo-wide preferences and conventions go in this file (root AGENTS.md). Instructions that apply only to a specific app or package go in that folder's `AGENTS.md` (e.g. `apps/backend/AGENTS.md`); create the file if it doesn't exist. Add or update the list above when you create or change an app/package AGENTS.md so future agents know where to look.

## Architecture decisions & ADRs

- **Where ADRs live**: All ADRs are in **ConKeeper memory**: `.ai/memory/decisions/`. Files are named `ADR-NNN-title-slug.md` (e.g. `ADR-001-frontend-ui-app-stack.md`).
- **When you change architecture**: Before making structural or architectural changes (adding/changing apps, packages, tooling, or cross-cutting patterns), read the relevant ADRs in `.ai/memory/decisions/` first.
- **Keeping ADRs up to date**: When you make a new architectural decision, use `memory-sync` skill to update ConKeeper memory.
- **Agent workflow**: Treat ADRs as the source of truth for high-level decisions. If the code and ADRs disagree, prefer updating the ADRs (and then the code) so future agents can follow a consistent story.
- **Connectors data model**: GitHub and Confluence/Forge integrations live in **`connections`** (`con_*`, typed `github` \| `forge`); see [ADR-018](.ai/memory/decisions/ADR-018-unified-connections-table.md). Prefer **`connectionId`** or repo-scoped resolution over “one install per org” assumptions.

## Local development

- **Docker Compose**: Single [docker-compose.yml](docker-compose.yml) uses **profiles** (see [.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md](.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md)). `pnpm dev:infra` runs `docker compose --profile infra up -d` (Postgres, FalkorDB, OTEL only). `pnpm start` runs `docker compose --profile deploy up -d` (production images: migrate, backend, worker, UI, codesearch). For day-to-day coding, **`pnpm dev`** runs backend + UI on the host (portless + Turbo) and **codesearch in Docker** ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh): `start.sh` = Zoekt + API, random host port → **`CODESEARCH_URL`**). For **internet-facing webhooks**, run **`pnpm dev:tailscale`** instead (Turbo **`dev:tailscale`** in [`turbo.json`](turbo.json)); **`apps/backend`** and **`apps/ui`** **`dev:tailscale`** scripts run **`../../node_modules/.bin/portless --funnel`** (plain **`dev`** stays without **`--funnel`**) — see host dev runbook step 5). Override host ports via **`CTXPIPE_*`** — [docker-compose.env.example](docker-compose.env.example). Optional **Amplitude** analytics env (`AMPLITUDE_API_KEY`, `AMPLITUDE_REGION`) is documented there and in [apps/backend/.env.example](apps/backend/.env.example) (ADR-017).

### Cursor Cloud specific instructions

Cloud agents run on an isolated Ubuntu machine. This repo provides a default cloud-agent environment config at **`.cursor/environment.json`** (implemented as `.cursor → .agents` symlink + [`.agents/environment.json`](.agents/environment.json)).

- **Docker image**: the environment is built from [`.agents/Dockerfile`](.agents/Dockerfile) following Cursor’s **Running Docker** guidance ([Cloud Agent setup](https://cursor.com/docs/cloud-agent/setup)): Docker CE + `fuse-overlayfs` + `iptables-legacy`, plus **Node.js**, **pnpm**, and **Bun** (matches root `package.json` `engines` and backend dev scripts). **`start`** runs [`.agents/start.sh`](.agents/start.sh): `sudo service docker start` and wait until `docker info` succeeds so `docker compose` is ready before tasks.
- **Rebuild after changing the Dockerfile**: Cursor only applies `.cursor/environment.json` when the cloud image is (re)built. If `docker` is missing on the agent VM, the environment is not using this Dockerfile—rebuild at [cursor.com/onboard](https://cursor.com/onboard) or bump the image so the **build** step runs again.
- **Install/update**: after the image boots, Cursor runs `corepack enable && pnpm install` from the repo root (`install` in `environment.json`).
- **Docker + Postgres**:
  - **Important**: `localhost` in cloud agents is the **cloud VM**, not your laptop.
  - If Docker is available on the VM, the agent can start the same infra stack you use locally with **`pnpm dev:infra`** (Postgres on `localhost:5433`, FalkorDB on `localhost:6379` by default; see [docker-compose.yml](docker-compose.yml) and [docker-compose.env.example](docker-compose.env.example)).
  - If Docker is **not** available or you prefer managed services, use a hosted Postgres and set `DATABASE_URL` via Secrets.
- **Secrets (Cursor dashboard → Cloud Agents → Secrets)**:
  - **Required**: `AUTH_SECRET` (≥ 32 chars) for backend auth initialization/tests (see [apps/backend/.env.example](apps/backend/.env.example)).
  - **Database**: set `DATABASE_URL` unless you intentionally rely on a Compose-started Postgres on the VM (e.g. `postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe`).
  - **Optional**: `GRAPH_DB_URI` (when running graph features; use `redis://localhost:6379` if FalkorDB is started by `pnpm dev:infra`), and any model/API keys you need for specific tasks.
- **Suggested verification commands** (no full dev stack):
  - `pnpm lint`
  - `pnpm --filter @ctxpipe/backend test`
  - `pnpm --filter @ctxpipe/ui test`
- **Running dev servers on cloud VMs** (without portless):
  - **Portless requires HTTPS on port 443** and a local CA; this does not work on headless cloud VMs. Skip `pnpm dev` (which invokes portless via `scripts/dev-apps.sh`). Instead start services individually:
    1. `pnpm dev:infra` — starts Postgres, FalkorDB, OTEL via Docker Compose.
    2. Backend: `cd apps/backend && bun run --hot src/server.ts` (listens on **`http://localhost:3000`**).
    3. UI: `cd apps/ui && VITE_PUBLIC_API_URL=http://localhost:3000 npx vite dev --host 0.0.0.0 --port 3002` (Vite on **`http://localhost:3002`**).
  - **Browser entry point**: access **`http://localhost:3000`** (backend). The backend proxies unmatched routes to `UI_PROXY_URL` (`http://localhost:3002`). The UI auth client resolves `baseURL` from `window.location.origin`, so sign-in only works when the browser origin matches the backend (port 3000). Visiting port 3002 directly will cause auth "Request failed" errors.
  - **`.env.local` and secrets**: [`.agents/start.sh`](.agents/start.sh) auto-generates `apps/backend/.env.local` from Cursor secrets (`AUTH_SECRET`, `DATABASE_URL`, `GRAPH_DB_URI`) on first boot. No manual file creation needed.
  - **Docker + Bun**: handled automatically by [`.agents/start.sh`](.agents/start.sh) (dockerd fallback + socket permissions) and [`environment.json`](.agents/environment.json) (bun install fallback). See those files if debugging startup.

### Agent runbook — host dev (run from repo root)

Run **`pnpm`** commands from the **repository root** (not inside `apps/*`).

1. **`pnpm install`**
2. **`apps/backend/.env.local`**: copy from [apps/backend/.env.example](apps/backend/.env.example) if missing. Set **`AUTH_SECRET`** (≥ 32 characters). Set **`DATABASE_URL`** / **`GRAPH_DB_URI`** as in the example (Postgres default **5433** on host, FalkorDB **`redis://localhost:6379`** when infra is up). **Linked git worktree**: use a **`DATABASE_URL`** whose database name is the per-worktree DB ([`scripts/worktree-db.sh`](scripts/worktree-db.sh) creates `ctxpipe_<sanitized_branch>`; match that name so **`pnpm dev`** and backend match migrate). **Normal clone**: default database name **`ctxpipe`** is enough.
3. **`pnpm dev:infra`** — Docker must be running. Starts Postgres, FalkorDB, otel-collector (Compose **`infra`** profile only).
4. **`pnpm dev`** — Starts the portless HTTPS proxy (default **HTTPS on port 443**; macOS/Linux may prompt for elevation to bind the port). Exports **`AUTH_BASE_URL`**, **`UI_PROXY_URL`**, **`VITE_PUBLIC_API_URL`**, and **`AUTH_ALLOWED_ORIGINS`** via **`pnpm exec portless get`**; starts a **codesearch Docker** container ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh)) and sets **`CODESEARCH_URL`** to `http://127.0.0.1:<random-port>`; then Turbo runs backend **`migrate`** first (see below), then **backend + UI** (codesearch is not run on the host). **Browse and test at `https://app.ctxpipe.localhost`** (clean URL, no port in the address bar), not **`ui.ctxpipe`** or raw localhost ports for the integrated app. Worktree prefixes follow [portless](https://portless.sh/) (branch subdomain on linked worktrees). Trust the dev CA once: **`pnpm trust`** from the repo root ([portless.sh](https://portless.sh/)).
5. **`pnpm dev:tailscale`** (optional) — Same **`pnpm dev`** stack with Portless **Tailscale Funnel**: [`turbo.json`](turbo.json) declares **`dev:tailscale`**; **`apps/backend`** and **`apps/ui`** [`package.json`](package.json) scripts run **`../../node_modules/.bin/portless --funnel ...`** vs plain **`portless`** without **`--funnel`** (no sentinel or funnel-only env injected into Turbo). Root **`pnpm dev`** runs **`scripts/dev-apps.sh`** with **`CTXPIPE_TURBO_DEV_TASK`** unset (**`env -u`**) so **`pnpm exec turbo run dev`** runs; **`pnpm dev:tailscale`** sets **`CTXPIPE_TURBO_DEV_TASK=dev:tailscale`** so Turbo runs **`dev:tailscale`** for the filtered apps. Prefer **either** **`pnpm dev`** **or** **`pnpm dev:tailscale`** during a session for a consistent proxy; **`pnpm exec portless proxy stop`** clears a wedged HTTPS stack when switching modes. Public webhook/OAuth origins are **`funnel:`** lines from **`pnpm exec portless list`**. Set **`PORTLESS_TAILSCALE_URL`** so the backend merges the public HTTPS app origin.

   **Tailscale / Funnel (operators)**

   Declarative tailnet access control lives in **[Grants](https://tailscale.com/docs/features/access-control/grants)**; use that alongside the current [Tailscale Funnel overview](https://tailscale.com/kb/1312/tailscale-funnel-overview). The tailnet policy must explicitly allow funnel access for whoever runs **`pnpm dev:tailscale`** on that machine (node attributes / tagging as Tailscale describes). **`tailscaled`** must be running and **`tailscale logged in`**. Treat Funnel development as exposing your local backend — keep Grants tight.

**Migrations only** (no dev servers): **`pnpm db:migrate`** from repo root.

**How migrate picks `DATABASE_URL`**: [`apps/backend/package.json`](apps/backend/package.json) **`db:migrate`** runs **`source ../../scripts/worktree-db.sh`** then **`drizzle-kit migrate`**. In a **linked** worktree, the script creates the DB if needed and **`export`s `DATABASE_URL` in that shell** (no `.env` edits). That requires **`psql`** on `PATH` to talk to Postgres. In a **normal** checkout, the script does nothing to the shell; Drizzle uses **`DATABASE_URL`** from `.env.local` / defaults.

**Direct script** (optional): **`eval "$(./scripts/worktree-db.sh)"`** sets `DATABASE_URL` in the **current** shell (script prints `export …` when run with `bash`, not `source`).

**Codesearch**: provided by Docker during **`pnpm dev`** (requires Docker). See [`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh).

**Documentation site** ([apps/docs](apps/docs/AGENTS.md)): **`pnpm dev:docs`** starts Next.js on **http://localhost:3003** — the docs app is at the site root (**`/`**); **`/docs`** is still the Fumadocs base path for doc URLs. Root **`pnpm dev`** runs backend + UI only; use **`pnpm dev:docs`** or **`pnpm dev --filter @ctxpipe/docs`** (args forwarded in [`scripts/dev-apps.sh`](scripts/dev-apps.sh)) when you need the docs app.

### Container deploy (Compose `deploy` profile)

From the repo root, set **`AUTH_SECRET`** (≥ 32 characters), **`AUTH_BASE_URL`**, **`CTXPIPE_PUBLIC_APP_URL`** (usually the public origin users use for the API / app), and optionally **`AUTH_ALLOWED_ORIGINS`** in a root **`.env`** next to [docker-compose.yml](docker-compose.yml) — see [docker-compose.env.example](docker-compose.env.example). Then run **`pnpm start`** (builds images on first run). TLS and a reverse proxy in front of published ports are left to the operator. Better Auth schema upgrades may require **`pnpm --filter @ctxpipe/backend auth:migrate`** against the same database when upgrading.

## Parallel worktrees and coding agents

Use **one shared Postgres** on the host (default **5433**) and **one database per linked worktree**. CI uses its own DB (default name **`ctxpipe`**); see [.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md](.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md).

1. **Port conflicts**: Copy [docker-compose.env.example](docker-compose.env.example) → `.env` at repo root; assign a fresh **`CTXPIPE_*`** block if ports clash (Postgres can stay on **5433** if only one Compose stack runs).
2. **HTTP / [portless](https://portless.sh/)**: Host dev uses **`pnpm dev`** so env matches **`portless get`** for **`app.ctxpipe`** and **`UI_PROXY_URL`**. **`CODESEARCH_URL`** is set by [`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh) to **`http://127.0.0.1:<random-port>`** (server-side only; not a portless hostname). The **browser entrypoint** for the product is **`https://app.ctxpipe.localhost`**, not **`ui.ctxpipe`** or raw localhost ports for the API.
3. **`.cursor` → `.agents`**: In this repo, **`.cursor` is a symlink to `.agents`** (same files on disk). [Cursor parallel worktrees](https://cursor.com/docs/configuration/worktrees) read **`worktrees.json`** at **`.cursor/worktrees.json`** — that file contains **only** Cursor’s `setup-worktree` keys (see [`worktrees.json`](.agents/worktrees.json): `pnpm install` and `pnpm db:migrate`). Copy **`apps/backend/.env.local`** from your primary checkout or from [`.env.example`](apps/backend/.env.example) if the new worktree needs secrets; that is not automated. **Local ports and URLs** for dev and MCP follow this runbook, [docker-compose.env.example](docker-compose.env.example), and [apps/backend/.env.example](apps/backend/.env.example) (use **`portless get app.ctxpipe`** for HTTPS in host dev, not raw localhost guesses).

## Code style

- **Avoid pulling to globals**: Do not extract config or one-off values to module/global scope unless they are reused in more than one place. Inline them where they are used.
- **Environment variables**: Use only for values that differ by **environment** or that **operators/customers must set** (secrets, base URLs, infra limits). Do not use env for **feature toggles** or **internal logic**; keep those in code or committed config. See [.ai/memory/patterns.md](.ai/memory/patterns.md) (Code conventions).
- **Backend logging**: In `apps/backend`, use **evlog** (`getLogger()` or `log` from `src/observability/logger.ts`) — not `console.*`. See [apps/backend/AGENTS.md](apps/backend/AGENTS.md) (Logging).

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
