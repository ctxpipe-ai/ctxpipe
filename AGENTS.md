## Where agent instructions live

Agent instructions are **distributed**: this file covers repo-wide rules; apps and packages can have their own `AGENTS.md` with local instructions. When working in an app or package, read both the root AGENTS.md and that folder's AGENTS.md (if present).

- **Root** (this file): architecture, code style.
- **apps/backend**: [apps/backend/AGENTS.md](apps/backend/AGENTS.md) — API, OpenAPI, MCP, Drizzle, TypeScript, etc.
- **apps/otel-collector**: OpenTelemetry Collector for Better Stack + LangFuse; config + `.env` in `apps/otel-collector/`.
- **apps/codesearch**: [apps/codesearch/AGENTS.md](apps/codesearch/AGENTS.md) — Zoekt/SCIP orchestration, read-only DB, OpenAPI + Zod, and the manual Kubernetes ingest memory gate.
- **apps/ui**: [apps/ui/AGENTS.md](apps/ui/AGENTS.md) — TanStack Start frontend, React Aria, Tailwind, Storybook, Vitest; **[React skill](.agents/skills/react/)** when building or editing components.
- **apps/docs**: [apps/docs/AGENTS.md](apps/docs/AGENTS.md) — Fumadocs documentation site (Next.js 15, Shiki, forced-dark, deploys to docs.ctxpipe.ai).
- **examples/**: runnable consumer examples for ctxpipe packages (manual e2e tests against real infra). See [examples/README.md](examples/README.md); first entry is [examples/aws-cdk-self-host](examples/aws-cdk-self-host) for `@ctxpipe-ai/aws-cdk` on AWS.

**MCP (project-scoped):** Config lives at [`.cursor/mcp.json`](.cursor/mcp.json) (same file as [`.agents/mcp.json`](.agents/mcp.json) via the `.agents` → `.cursor` symlink). Two kinds of servers:

1. **Product MCP (`ctxpipe`)** — hosted org MCP for the product itself (`https://app.ctxpipe.ai/mcp?orgSlug=ctx-tev`). This is the customer-facing ctxpipe tool surface agents use against the live org; do **not** point it at localhost.
2. **Agent tooling MCPs** — editor/agent helpers for this repo (Storybook, Neon, Amplitude, Railway, Langfuse, Better Stack). Not the backend’s in-process Hono `/mcp` product server.

| Server | Purpose | Preconditions |
| --- | --- | --- |
| `ctxpipe` | Hosted product MCP (org `ctx-tev`) | OAuth / account access to that org in Cursor |
| `ctxpipe-storybook` | Storybook MCP at `http://127.0.0.1:6006/mcp` | Storybook must be running: `pnpm --filter @ctxpipe/ui storybook` |
| `neon` | Neon Lakebase Postgres via hosted MCP — **read-only** (`?readonly=true`) | OAuth in Cursor (uncheck Full access if prompted; URL param forces RO). Optional headless: Bearer `NEON_API_KEY` + same `readonly=true` URL ([Neon MCP docs](https://neon.com/docs/ai/neon-mcp-server)) |
| `amplitude` | Amplitude analytics MCP (US) | OAuth in Cursor ([Amplitude Cursor setup](https://amplitude.com/docs/amplitude-ai/amplitude-mcp/cursor)); EU → `https://mcp.eu.amplitude.com/mcp` |
| `railway` | Railway status + logs / deploys | OAuth in Cursor (`type: streamable-http` → `https://mcp.railway.com`) |
| `langfuse` | Langfuse **project** MCP (traces/prompts) | Cursor/env secrets: `LANGFUSE_BASE_URL` (e.g. `https://us.cloud.langfuse.com`) and `LANGFUSE_AUTH_STRING` = base64(`pk:sk`); see [apps/otel-collector/.env.example](apps/otel-collector/.env.example) |
| `betterstack` | Better Stack uptime + telemetry | OAuth in Cursor (or Bearer API token via header if needed) |

**Not wired** (intentionally): local Postgres MCP, GitHub MCP, codesearch MCP, Linear/Notion MCP.

**Ops debugging / logs (preference order):** When investigating deployed or production-like behavior, prefer MCP sources in this order — do **not** assume a local `.evlog/logs/` filesystem drain for product debugging (ctxpipe backend uses OTLP / stdout; see [`.agents/skills/analyze-logs`](.agents/skills/analyze-logs/SKILL.md)):

1. **Railway MCP** (`railway`) — service status + deploy/runtime logs (**primary**).
2. **Langfuse MCP** (`langfuse`) — traces / LLM / advisor quality.
3. **Better Stack MCP** (`betterstack`) — only when uptime/telemetry data is present and needed for the question.

For Storybook conventions and tools, read [.agents/skills/storybook/SKILL.md](.agents/skills/storybook/SKILL.md) with [apps/ui/AGENTS.md](apps/ui/AGENTS.md).

**Host dev (agents):** Run **`pnpm`** from the repo root; follow **Agent runbook — host dev** under [Local development](#local-development) (install → `.env.local` → `dev:infra` → `dev`).

**Cursor Cloud / remote headless agents:** Do **not** use `pnpm dev` (portless). Default to **[Running dev servers on cloud VMs](#cursor-cloud-specific-instructions)** in this file (copy-paste block + migrate + `bun --env-file=.env.local`).

**When feedback is given that should become a long-term instruction**: Save it into this structure. Repo-wide preferences and conventions go in this file (root AGENTS.md). Instructions that apply only to a specific app or package go in that folder's `AGENTS.md` (e.g. `apps/backend/AGENTS.md`); create the file if it doesn't exist. Add or update the list above when you create or change an app/package AGENTS.md so future agents know where to look.

## Agent skills

Skills that say "commit your work" (or similar) are overridden: create a git commit only when the user explicitly asks to commit in the conversation.

### Issue tracker

Local markdown under `.ai/scratchpad/<feature>/`. See [`.ai/agents/issue-tracker.md`](.ai/agents/issue-tracker.md).

### Triage labels

Default role labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [`.ai/agents/triage-labels.md`](.ai/agents/triage-labels.md).

### Domain docs

Single-context via `.ai/memory/` (product context, glossary, ADRs). See [`.ai/agents/domain.md`](.ai/agents/domain.md).

## Architecture decisions & ADRs

- **Where ADRs live**: All ADRs are in `.ai/memory/decisions/`. Files are named `ADR-NNN-title-slug.md` (e.g. `ADR-001-frontend-ui-app-stack.md`). Start from [`decisions/index.md`](.ai/memory/decisions/index.md).
- **When you change architecture**: Before making structural or architectural changes (adding/changing apps, packages, tooling, or cross-cutting patterns), read the relevant ADRs in `.ai/memory/decisions/` first.
- **Keeping ADRs up to date**: When you make a new architectural decision, use the `capture-adr` skill and update `decisions/index.md`.
- **Agent workflow**: Treat ADRs as the source of truth for high-level decisions. If the code and ADRs disagree, prefer updating the ADRs (and then the code) so future agents can follow a consistent story.
- **Connectors data model**: GitHub, Confluence/Forge, Slack, Linear, and Notion integrations live in **`connections`** (`con_*`, typed `github` \| `forge` \| `slack` \| `linear` \| `notion`); see [ADR-018](.ai/memory/decisions/ADR-018-unified-connections-table.md), [ADR-022](.ai/memory/decisions/ADR-022-linear-connector-git-native-mirror.md) (Linear), [ADR-023](.ai/memory/decisions/ADR-023-notion-connector-git-native-mirror.md) (Notion), and [ADR-025](.ai/memory/decisions/ADR-025-slack-connector-git-native-mirror.md) (Slack). Prefer **`connectionId`** or repo-scoped resolution over “one install per org” assumptions.

## Local development

- **Docker Compose**: Single [docker-compose.yml](docker-compose.yml) uses **profiles** (see [.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md](.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md)). **`pnpm dev:infra`** runs `docker compose --profile infra up -d` (Postgres, FalkorDB, OTEL only). **`pnpm start`** runs `docker compose --profile deploy up -d` (production images: migrate, backend, worker, UI, codesearch). For day-to-day coding, **`pnpm dev`** runs backend + UI on the host (portless + Turbo) and **codesearch in Docker** ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh): `start.sh` = Zoekt + API, random host port → **`CODESEARCH_URL`**). Override host ports via **`CTXPIPE_*`** — [docker-compose.env.example](docker-compose.env.example). Optional **Amplitude** analytics env (`AMPLITUDE_API_KEY`, `AMPLITUDE_REGION`) is documented there and in [apps/backend/.env.example](apps/backend/.env.example) (ADR-017).

### Cursor Cloud specific instructions

Cloud agents run on an isolated Ubuntu machine. This repo provides a default cloud-agent environment config at **`.cursor/environment.json`** (real file under **`.cursor/`**; **`.agents` → `.cursor`** symlink so [`.agents/environment.json`](.agents/environment.json) resolves to the same path).

- **Default for remote agents:** When you need the **running app** (API + proxied UI + auth in the browser), use **Running dev servers on cloud VMs** below — not `pnpm dev` (portless). Lint/tests-only work can skip servers; see **Suggested verification commands** below.
- **Docker image**: the environment is built from [`.agents/Dockerfile`](.agents/Dockerfile) following Cursor’s **Running Docker** guidance ([Cloud Agent setup](https://cursor.com/docs/cloud-agent/setup)): Docker CE + `fuse-overlayfs` + `iptables-legacy`, plus **Node.js**, **pnpm**, and **Bun** (matches root `package.json` `engines` and backend dev scripts). **`start`** runs [`.agents/start.sh`](.agents/start.sh): `sudo service docker start` and wait until `docker info` succeeds so `docker compose` is ready before tasks.
- **Personal dashboard overrides**: A personal Cloud Agent environment (dashboard) can override the committed `.cursor/environment.json`. If agents boot without Docker/Bun after enabling Builds, the active environment is likely a snapshot-only personal config that never built this Dockerfile—either Save an updated personal install/start that includes Docker tooling, or remove the personal override so the repo Dockerfile is used.
- **Rebuild after changing the Dockerfile**: Cursor only applies `.cursor/environment.json` when the cloud image is (re)built. If `docker` is missing on the agent VM, the environment is not using this Dockerfile—rebuild at [cursor.com/onboard](https://cursor.com/onboard) or bump the image so the **build** step runs again.
- **Install/update**: after the image boots, Cursor runs `corepack enable && pnpm install` from the repo root (`install` in `environment.json`).
- **Docker + Postgres**:
  - **Important**: `localhost` in cloud agents is the **cloud VM**, not your laptop.
  - If Docker is available on the VM, the agent can start the same infra stack you use locally with **`pnpm dev:infra`** (Postgres on `localhost:5433`, FalkorDB on `localhost:6379` by default; see [docker-compose.yml](docker-compose.yml) and [docker-compose.env.example](docker-compose.env.example)).
  - If **`pnpm dev:infra`** fails with **permission denied** on `/var/run/docker.sock` even after [`.agents/start.sh`](.agents/start.sh), run **`sudo docker compose --profile infra up -d`** from the repo root (same Compose file as `pnpm dev:infra`).
  - If Docker is **not** available or you prefer managed services, use a hosted Postgres and set `DATABASE_URL` via Secrets.
- **Secrets (Cursor dashboard → Cloud Agents → Secrets)**:
  - **Required**: `AUTH_SECRET` (≥ 32 chars) for backend auth initialization/tests (see [apps/backend/.env.example](apps/backend/.env.example)).
  - **Database**: set `DATABASE_URL` unless you intentionally rely on a Compose-started Postgres on the VM (e.g. `postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe`).
  - **Optional**: `GRAPH_DB_URI` (when running graph features; use `redis://localhost:6379` if FalkorDB is started by `pnpm dev:infra`), and any model/API keys you need for specific tasks.
- **Suggested verification commands** (no full dev stack):
  - `pnpm lint`
  - `pnpm --filter @ctxpipe/backend test`
  - `pnpm --filter @ctxpipe/ui test`
- **Running dev servers on cloud VMs** (without portless) — **default for Cursor Cloud and headless VMs**:
  - **Why:** Portless requires HTTPS on port 443 and a local CA; that does not work on headless cloud VMs. **`pnpm dev`** invokes portless via [`scripts/dev-apps.sh`](scripts/dev-apps.sh) — skip it here.
  - **Steps** (run migrations once after infra is up):
    1. **`pnpm dev:infra`** — Postgres, FalkorDB, OTEL. If the socket error above applies, use **`sudo docker compose --profile infra up -d`** from the repo root instead.
    2. **`pnpm db:migrate`** — from repo root; applies schema to the database in `apps/backend/.env.local`.
    3. **Backend:** `cd apps/backend && bun --env-file=.env.local run --hot src/server.ts` — **`http://localhost:3000`**. Use **`--env-file=.env.local`** so secrets and `DATABASE_URL` load reliably.
    4. **UI** (second process): `cd apps/ui && VITE_PUBLIC_API_URL=http://localhost:3000 npx vite dev --host 0.0.0.0 --port 3002` — Vite on port **3002**.
  - **Browser entry point:** **`http://localhost:3000`** (backend). The backend proxies SPA routes to **`UI_PROXY_URL`** (`http://localhost:3002` — [`.agents/start.sh`](.agents/start.sh) sets this when it generates `.env.local`). The auth client uses `window.location.origin`; use **port 3000** in the browser, not 3002 alone (avoids Better Auth / “Request failed” issues).
  - **Optional — noisy OTLP:** If the shell exports `OTEL_EXPORTER_OTLP_*` to an unreachable collector, evlog may log connection errors when handling requests. For a quiet run, unset those variables when starting Bun (example: `env -u OTEL_EXPORTER_OTLP_LOGS_ENDPOINT -u OTEL_EXPORTER_OTLP_TRACES_ENDPOINT -u OTEL_EXPORTER_OTLP_METRICS_ENDPOINT -u OTEL_RESOURCE_ATTRIBUTES`).
  - **Codesearch:** This path does **not** start Zoekt/codesearch (that is wired by **`pnpm dev`** or Compose **`deploy`**). UI/auth/API work without it; repository search/MCP features that need codesearch require full host dev or **`pnpm start`**.
  - **`.env.local` and secrets:** [`.agents/start.sh`](.agents/start.sh) auto-generates `apps/backend/.env.local` from Cursor secrets (`AUTH_SECRET`, `DATABASE_URL`, `GRAPH_DB_URI`) when the file is missing, and sets **`AUTH_BASE_URL`**, **`UI_PROXY_URL`**, and **`AUTH_ALLOWED_ORIGINS`** for this HTTP layout. If you maintain `.env.local` by hand, keep those aligned with **localhost:3000** / **localhost:3002** for this runbook.
  - **Docker + Bun**: handled automatically by [`.agents/start.sh`](.agents/start.sh) (dockerd fallback + socket permissions) and [`environment.json`](.agents/environment.json) (bun install fallback). See those files if debugging startup.

#### Agent runbook — Cursor Cloud / headless VMs (copy-paste)

```bash
# repo root
pnpm dev:infra                    # or: sudo docker compose --profile infra up -d
pnpm db:migrate
cd apps/backend && bun --env-file=.env.local run --hot src/server.ts
# second terminal, repo root
cd apps/ui && VITE_PUBLIC_API_URL=http://localhost:3000 npx vite dev --host 0.0.0.0 --port 3002
```

Open **`http://localhost:3000`** for the integrated app.

### Agent runbook — host dev (run from repo root)

Run **`pnpm`** commands from the **repository root** (not inside `apps/*`).

1. **`pnpm install`**
2. **`apps/backend/.env.local`**: copy from [apps/backend/.env.example](apps/backend/.env.example) if missing. Set **`AUTH_SECRET`** (≥ 32 characters). Set **`DATABASE_URL`** / **`GRAPH_DB_URI`** as in the example (Postgres default **5433** on host, FalkorDB **`redis://localhost:6379`** when infra is up). **Linked git worktree**: use a **`DATABASE_URL`** whose database name is the per-worktree DB ([`scripts/worktree-db.sh`](scripts/worktree-db.sh) creates `ctxpipe_<sanitized_branch>`; match that name so **`pnpm dev`** and backend match migrate). **Normal clone**: default database name **`ctxpipe`** is enough.
3. **`pnpm dev:infra`** — Docker must be running. Starts Postgres, FalkorDB, otel-collector (Compose **`infra`** profile only).
4. **`pnpm dev`** — Starts the portless HTTPS proxy (default **HTTPS on port 443**; macOS/Linux may prompt for elevation to bind the port). Exports **`AUTH_BASE_URL`**, **`UI_PROXY_URL`**, **`VITE_PUBLIC_API_URL`**, and **`AUTH_ALLOWED_ORIGINS`** via **`pnpm exec portless get`**; starts a **codesearch Docker** container ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh)) and sets **`CODESEARCH_URL`** to `http://127.0.0.1:<random-port>`; then Turbo runs backend **`migrate`** first (see below), then **backend + UI** (codesearch is not run on the host). **Browse and test at `https://app.ctxpipe.localhost`** (clean URL, no port in the address bar), not **`ui.ctxpipe`** or raw localhost ports for the integrated app. Worktree prefixes follow [portless](https://portless.sh/) (branch subdomain on linked worktrees). Trust the dev CA once: **`pnpm trust`** from the repo root ([portless.sh](https://portless.sh/)).

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
3. **`.agents` → `.cursor`**: In this repo, **`.cursor` is the real directory** and **`.agents` is a symlink to `.cursor`** (same files on disk). [Cursor parallel worktrees](https://cursor.com/docs/configuration/worktrees) read **`worktrees.json`** at **`.cursor/worktrees.json`** — that file contains **only** Cursor’s `setup-worktree` keys (see [`worktrees.json`](.cursor/worktrees.json): `pnpm install` and `pnpm db:migrate`). Copy **`apps/backend/.env.local`** from your primary checkout or from [`.env.example`](apps/backend/.env.example) if the new worktree needs secrets; that is not automated. **Local ports and URLs** for dev and MCP follow this runbook, [docker-compose.env.example](docker-compose.env.example), and [apps/backend/.env.example](apps/backend/.env.example) (use **`portless get app.ctxpipe`** for HTTPS in host dev, not raw localhost guesses).

### Git branches (agents)

- **Stay on the current branch** for follow-up planning/implementation sessions. Do **not** create a new branch (or worktree branch) unless `HEAD` is already on **`main`** (or the user explicitly asks for a new branch).
- Multiple plans/features in one PR branch are normal; continue committing on the existing feature branch.
- If you are on `main` and need isolated work, then create a feature branch from `main`.

## Local agent memory

Durable agent memory is **Markdown-only** under **[.ai/memory/](.ai/memory/)**. Navigate via [`index.md`](.ai/memory/index.md). Host hooks append gitignored candidates under `.ai/memory/events/`; agents promote with capture skills and **must update the matching `index.md`**. Design: [ADR-024](.ai/memory/decisions/ADR-024-markdown-only-local-memory-capture.md) (supersedes ADR-021).

- **Setup**: `npx ctxpipe memory init --agents cursor,…` seeds layout, always-apply rule, capture skills, and host hooks (no remote ctxpipe MCP; no local memory MCP). Full init with memory: `npx ctxpipe init --memory`.
- **CLI**: `ctxpipe memory init` · `ctxpipe memory capture observe|summary` (hooks) · `ctxpipe memory status|doctor`.
- **Rules**: never commit secrets; never auto-write durable ADRs from hooks; prefer [`lessons-learned.md`](.ai/memory/lessons-learned.md) for confirmed conventions.

## Code style

- **Avoid pulling to globals**: Do not extract config or one-off values to module/global scope unless they are reused in more than one place. Inline them where they are used.
- **Environment variables**: Use only for values that differ by **environment** or that **operators/customers must set** (secrets, base URLs, infra limits). Do not use env for **feature toggles** or **internal logic**; keep those in code or committed config. See [.ai/memory/lessons-learned.md](.ai/memory/lessons-learned.md). **Agents:** Do not add or document **new** environment variables unless they are **required** to complete the assigned task — prefer resolving paths or behavior in committed code rather than expanding operator surface area.
- **Backend logging**: In `apps/backend`, use **evlog** (`getLogger()` or `log` from `src/observability/logger.ts`) — not `console.*`. See [apps/backend/AGENTS.md](apps/backend/AGENTS.md) (Logging).

## Package releases

- Changes that should ship in **`@ctxpipe/aws-cdk`** must include a new `.changeset/*.md` file created with `pnpm changeset` (patch/minor/major + short summary).
- Releases use [Changesets](https://github.com/changesets/changesets): merge to `main` opens a **version packages** PR via `.github/workflows/deploy.yaml`; merging that PR publishes to npm.
- `packages/aws-cdk/src/pinned-service-image-tag.ts` is generated during `@ctxpipe/aws-cdk` build by `scripts/release/stamp-aws-cdk-image-tag.mjs` (`IMAGE_TAG`/`GITHUB_SHA`, fallback to latest known `main` SHA via git refs, then `latest`).
- Keep package changes buildable with `pnpm turbo build --filter @ctxpipe/aws-cdk`.

