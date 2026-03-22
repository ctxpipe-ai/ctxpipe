# ADR-004: Local development with Docker Compose

**Status:** Accepted | **Date:** 2026-02-13 | **Tags:** dev, docker, compose

## Context

The backend depends on PostgreSQL (Drizzle) and will use Neo4j for graph workloads. We need a predictable local development environment that:

- Runs Postgres and Neo4j without requiring developers to install or manage them manually.
- Keeps frontend and API clients simple: one base URL for the backend.

The monorepo root already has a `dev` script; we must avoid starting the backend twice (once in Docker, once via Turbo) and keep the dev workflow clear.

## Decision

1. **Single Docker Compose file at repo root** (`docker-compose.yml`):

   - **postgres**: `postgres:16-alpine`, default DB `ctxpipe`, configurable via `POSTGRES_*` env vars; healthcheck so backends can wait for readiness.
   - **neo4j**: `neo4j:5`, ports 7474 (HTTP) and 7687 (Bolt); auth via `NEO4J_AUTH`.
   - **backend-bun**: Default backend service; runs `pnpm --filter @ctxpipe/backend dev` (Bun server) with `DATABASE_URL` and `NEO4J_URI` pointing at the Compose services. Exposes port **3000**.

2. Frontends and API clients can always use `https://localhost:3000`.

3. **Root `pnpm dev` runs only Docker Compose**: The root `dev` script is `docker compose up`. It does **not** run `turbo dev`, so the backend is not started a second time. Other apps (e.g. frontend) are started separately with their own dev commands.

4. **Backend env contract**: `src/config/env.ts` defines optional `NEO4J_URI` in addition to `DATABASE_URL`.

5. **Dev image**: `apps/backend/Dockerfile.dev` provides a Bun-based image with pnpm; the Compose services mount the repo and run `pnpm install` then the appropriate dev command so code changes are reflected without rebuilding the image.

## Consequences

**Positive**

- One command (`pnpm dev`) brings up the full default stack (Postgres, Neo4j, Bun backend) with no double-start of the backend.
- Frontends and clients always target port 3000.
- Postgres and Neo4j are versioned and consistent across machines; credentials and URLs are configurable via env (and `.env` at root).
- ADR-002's "future Neo4j" is unblocked: the service and `NEO4J_URI` are in place for when the client is integrated.

**Negative / trade-offs**

- Root `dev` no longer starts other workspace apps (e.g. frontend); those must be started separately. This is intentional to avoid duplicate backend processes and to keep the primary "backend + databases" story in one place.
- Running the backend in Docker with a bind-mounted repo can be slower on some hosts than running it natively; developers can still run `docker compose up -d postgres neo4j` and then run the backend on the host with `DATABASE_URL` pointing at localhost.

## Alternatives Considered

- **Root `dev` = `docker compose up -d && turbo dev`**: Rejected because it would start the backend twice (in Docker and via Turbo).
- **Compose only for databases, backend always on host**: Kept as an optional workflow (infra-only Compose + backend on host) but not the default, so that a single `pnpm dev` gives a working backend without extra steps.

## Notes

- **Multiple git worktrees** on one machine: prefer one shared Postgres and **one database per worktree** — see [ADR-014](ADR-014-parallel-worktree-local-development.md).
- To run only databases and the backend on the host: `docker compose up -d postgres neo4j`, then from `apps/backend` set `DATABASE_URL` (e.g. `postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe`) and optionally `NEO4J_URI`, and run `pnpm dev`.
- Credentials and overrides: use a root `.env` (see `.env.example` if added) for `POSTGRES_*`, `NEO4J_AUTH`, and optional `DATABASE_URL` / `NEO4J_URI` overrides. Do not commit `.env`.
- Cloudflare Workers support was removed; see [ADR-007](ADR-007-remove-cloudflare-workers-runtime.md).
