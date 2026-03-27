# ADR-014: Parallel worktree local development

**Status:** Accepted | **Date:** 2026-03-22 | **Tags:** dev, worktree, agents, postgres

## Context

Multiple coding agents or developers may use **git worktrees** on one machine at the same time. That creates:

- **HTTP port conflicts** when every checkout assumes `localhost:3000` / `3002` / `3001`.
- **Database isolation** needs: each worktree should run migrations and tests against data that does not clobber another branch.

We ruled out **separate Docker Compose stacks per worktree** (extra Postgres/Falkor containers and RAM — see alternatives) and **Neon database branches per local worktree** (branch sprawl, cleanup, and cost versus CI’s existing Neon-per-PR pattern).

## Decision

1. **Postgres (local)**: Use **one shared Postgres instance** (Compose `postgres` service, default host port `5433`) and **one database per linked git worktree**, named `ctxpipe_<sanitized_branch>`. [`scripts/worktree-db.sh`](../../../scripts/worktree-db.sh) ensures the database exists and sets `DATABASE_URL` when **sourced** (or prints `export DATABASE_URL=…` when run with `bash`); [`apps/backend/package.json`](../../../apps/backend/package.json) **`db:migrate`** runs `source ../../scripts/worktree-db.sh` before Drizzle (no `.env` writes). Dev servers may still use `apps/backend/.env.local` for `DATABASE_URL` and other vars. **CI** uses an isolated environment and the default database name (`ctxpipe`) — no per-branch naming there.

   **Docker Compose and worktrees:** Use **one** shared infra stack (**`pnpm dev:infra`** — Postgres, FalkorDB, OTEL, Zoekt). A **second** checkout must **not** start a **second** Compose stack on the same host ports; run **application processes from the host** in other worktrees (`pnpm dev` under `apps/backend` / `apps/ui` with portless or distinct `PORT`). Set the same **`COMPOSE_PROJECT_NAME`** in each worktree’s root `.env` when using Compose from multiple paths so `docker compose` targets the same containers (see [`docker-compose.env.example`](../../../docker-compose.env.example)).

2. **CI / preview**: **Unchanged** — PR workflows may continue to use **Neon branch databases** ([`.github/workflows/pr-deploy.yaml`](../../../.github/workflows/pr-deploy.yaml)). This ADR applies to **local** parallel worktrees, not replacing cloud preview DBs.

3. **Compose host ports**: [`docker-compose.yml`](../../../docker-compose.yml) exposes **parameterized host ports** (e.g. `CTXPIPE_POSTGRES_HOST_PORT`, defaults in [`docker-compose.env.example`](../../../docker-compose.env.example)) so a second Compose project or process can shift bindings without editing YAML.

4. **HTTP**: Prefer **[portless](https://github.com/vercel-labs/portless)** or explicit `PORT` + documented public URL; align **`AUTH_BASE_URL`**, **`AUTH_ALLOWED_ORIGINS`**, and UI auth client origins with the effective origin (including `PORTLESS_URL` when used).

5. **Cursor worktree setup**: **[`.agents/worktrees.json`](../../../.agents/worktrees.json)** is **Cursor-only** (`setup-worktree*` per [Cursor worktrees docs](https://cursor.com/docs/configuration/worktrees)); same path as **`.cursor/worktrees.json`** because **`.cursor` symlinks to `.agents`**. Ports, URLs, and MCP usage for local dev are documented in root [AGENTS.md](../../../AGENTS.md), [docker-compose.env.example](../../../docker-compose.env.example), and [apps/backend/.env.example](../../../apps/backend/.env.example).

## Consequences

**Positive**

- Low resource use versus one Postgres container per worktree.
- No unbounded Neon branch count for local development.
- Clear convention for DB naming and MCP URLs.

**Negative / trade-offs**

- Developers must **not** point two worktrees at the same `DATABASE_URL` by mistake.
- **FalkorDB / graph** sharing across worktrees is not fully specified here; teams may still need separate graph instances or careful usage if graph state collides.

## Alternatives Considered

- **A — Full Compose stack per worktree** (unique project name + port offsets): maximum isolation, highest RAM and operational overhead — **rejected** for local parallel agents.
- **C — Neon branch per local worktree**: same isolation model as CI but **rejected** for local use due to branch sprawl and cost without strong lifecycle management.

## Related

- [ADR-004: Local development with Docker Compose](ADR-004-local-development-docker-compose.md) (Compose layout superseded by [ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md))
- [ADR-015: Docker Compose profiles and small-scale container deploy](ADR-015-docker-compose-profiles-and-small-scale-deploy.md)
