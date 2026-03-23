# ADR-004: Local development with Docker Compose

**Status:** Superseded | **Superseded by:** [ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md) | **Date:** 2026-02-13 | **Tags:** dev, docker, compose

## Context

The backend depends on PostgreSQL (Drizzle) and a graph store (FalkorDB / OpenCypher). Local development needs predictable data services without requiring every developer to install Postgres, FalkorDB, or Zoekt binaries on the host.

We run **application processes on the host** (root **`pnpm dev`** — portless + Turbo) and use Compose **only for backing services** so we never start the backend twice (Compose app containers + Turbo).

## Decision

1. **Single Docker Compose file at repo root** ([`docker-compose.yml`](../../../docker-compose.yml)) defines **infra only** for local development:

   - **postgres**: `pgvector/pgvector:pg17`; configurable via `POSTGRES_*` and `CTXPIPE_POSTGRES_HOST_PORT` (default host **5433**); healthcheck for readiness.
   - **falkordb**: graph / Redis protocol; host ports via `CTXPIPE_FALKOR_*`.
   - **otel-collector**: OpenTelemetry Collector (Better Stack + LangFuse fan-out when env is configured).
   - **zoekt-webserver**: Zoekt RPC for codesearch; image built from [`apps/codesearch/Dockerfile.zoekt`](../../../apps/codesearch/Dockerfile.zoekt); index volume `zoekt_index`.

2. **Root `pnpm dev:infra`** runs `docker compose up -d postgres falkordb otel-collector zoekt-webserver`. Application code (backend, UI, codesearch) runs via root **`pnpm dev`** ([`scripts/dev-apps.sh`](../../../scripts/dev-apps.sh)); see root [AGENTS.md](../../../AGENTS.md).

3. **Backend env contract**: `src/config/env.ts` defines `DATABASE_URL`, `GRAPH_DB_URI`, etc. Host dev uses `localhost` ports published by Compose.

4. **No containerized app dev services** in Compose: removed legacy `deps-install`, `backend-bun`, `ui-bun`, and `codesearch-bun` (previously used for full-stack-in-Docker).

## Consequences

**Positive**

- One **`pnpm dev:infra`** command brings up databases, OTEL, and Zoekt; **`pnpm dev`** runs the real dev workflow with fast reload on the host.
- No duplicate backend/UI processes between Compose and Turbo.
- Credentials and host ports stay configurable via root `.env` and [`docker-compose.env.example`](../../../docker-compose.env.example).

**Negative / trade-offs**

- Developers need Node/pnpm/Bun (and portless for the recommended integrated URL story) on the host; Compose does not run the apps.

## Alternatives Considered

- **Full stack in Compose (app containers)**: Previously available; **removed** — slower bind mounts, duplicated workflow with Turbo, and redundant now that host dev is standard.

- **Root `dev` = `docker compose up -d && turbo dev` with app services in Compose**: Rejected — would duplicate processes or require fragile exclusions.

## Notes

- **Multiple git worktrees** on one machine: prefer one shared Postgres and **one database per worktree** — see [ADR-014](ADR-014-parallel-worktree-local-development.md).
- **Credentials and overrides**: use a root `.env` for `POSTGRES_*` and `CTXPIPE_*`; do not commit `.env`.
- Cloudflare Workers support was removed; see [ADR-007](ADR-007-remove-cloudflare-workers-runtime.md).
