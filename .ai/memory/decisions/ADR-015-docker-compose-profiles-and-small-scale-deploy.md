# ADR-015: Docker Compose profiles and small-scale container deploy

**Status:** Accepted | **Date:** 2026-03-23 | **Tags:** dev, docker, compose, deploy

## Context

The root [`docker-compose.yml`](../../../docker-compose.yml) must support:

1. **Local host development** — backing services only (Postgres, FalkorDB, OTEL), with backend + UI on the host via [`scripts/dev-apps.sh`](../../../scripts/dev-apps.sh) (portless + Turbo). **Codesearch** runs in Docker from [`scripts/codesearch-docker-dev.sh`](../../../scripts/codesearch-docker-dev.sh) (production image + [`start.sh`](../../../apps/codesearch/start.sh): Zoekt + API). `pnpm dev:infra` must not require app secrets such as `AUTH_SECRET`.

2. **Small-scale production / self-hosted deploy** — one command brings up production images (backend, UI, codesearch, OpenWorkflow worker) with internal Docker networking, without bind mounts or `pnpm dev` / portless.

Legacy Compose had containerized dev commands and removed `Dockerfile.dev` files; those workflows are incompatible with portless-wrapped dev scripts.

## Decision

1. **Profiles** (same file):

   - **`infra`** — `postgres`, `falkordb`, `otel-collector`. Used by **`pnpm dev:infra`** → `docker compose --profile infra up -d`. Local Zoekt is **not** a Compose service; it runs inside the codesearch Docker container during **`pnpm dev`** ([`scripts/codesearch-docker-dev.sh`](../../../scripts/codesearch-docker-dev.sh)).

   - **`deploy`** — Shared data services plus app containers: **`migrate`** (one-shot Drizzle migration via [`apps/backend/src/db/migrate.ts`](../../../apps/backend/src/db/migrate.ts)), **`backend`**, **`worker`**, **`ui`**, **`codesearch`**. Used by **`pnpm start`** → `docker compose --profile deploy up -d`.

2. **Dual-tagging** — `postgres`, `falkordb`, and `otel-collector` use `profiles: [infra, deploy]` so they participate in both modes.

3. **Zoekt** — The **deploy** `codesearch` service and **host dev** (`codesearch-docker-dev.sh`) use [`apps/codesearch/Dockerfile`](../../../apps/codesearch/Dockerfile) and [`start.sh`](../../../apps/codesearch/start.sh) (Zoekt webserver + Bun in one container). Set **`ZOEKT_WEBSERVER_URL=http://127.0.0.1:6070`** inside that container. There is no separate **`zoekt-webserver`** Compose service for local dev.

4. **Images** — Production Dockerfiles only: [`apps/backend/Dockerfile`](../../../apps/backend/Dockerfile), [`apps/backend/Dockerfile.worker`](../../../apps/backend/Dockerfile.worker), [`apps/ui/Dockerfile`](../../../apps/ui/Dockerfile), [`apps/codesearch/Dockerfile`](../../../apps/codesearch/Dockerfile). UI build receives **`VITE_PUBLIC_API_URL`** via **`CTXPIPE_PUBLIC_APP_URL`** (Compose `build.args`).

5. **Secrets and public URLs** — Deploy operators set **`AUTH_SECRET`**, **`AUTH_BASE_URL`**, **`AUTH_ALLOWED_ORIGINS`**, and **`CTXPIPE_PUBLIC_APP_URL`** in root `.env` (see [`docker-compose.env.example`](../../../docker-compose.env.example)). Compose does not use `${VAR:?}` for `AUTH_SECRET` so **`pnpm dev:infra`** works without those variables; unset secrets fail at app startup when running the **deploy** profile.

## Consequences

**Positive**

- Single `docker-compose.yml` for infra and deploy; clear `pnpm` entrypoints.
- No portless or dev servers inside Compose for deploy.

**Negative / trade-offs**

- **`docker compose config`** interpolates all services; deploy env vars are documented but not enforced at Compose parse time for `AUTH_SECRET`.
- Better Auth **`auth:migrate`** is not automated in Compose; run manually when upgrading auth schema if required.

## Alternatives Considered

- **Separate `docker-compose.prod.yml`** — Rejected in favor of one file and profiles.
- **Default `docker compose up` with no profiles** — Rejected: profile-gated services keep infra-only and deploy stacks explicit (`pnpm dev:infra` vs `pnpm start`).

## Related

- Supersedes narrative for Compose layout: [ADR-004](ADR-004-local-development-docker-compose.md) (historical text retained).
- Parallel worktrees: [ADR-014](ADR-014-parallel-worktree-local-development.md).
