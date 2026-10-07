# ADR-015: Docker Compose profiles and small-scale container deploy

**Status:** Accepted | **Date:** 2026-03-23 | **Tags:** dev, docker, compose, deploy

## Context

The root [`docker-compose.yml`](../../../docker-compose.yml) must support:

1. **Local host development** — backing services only (Postgres, FalkorDB, OTEL), with backend + UI on the host via [`scripts/dev-apps.sh`](../../../scripts/dev-apps.sh) (portless + Turbo). **Codesearch** runs in Docker from [`scripts/codesearch-docker-dev.sh`](../../../scripts/codesearch-docker-dev.sh) (production image + [`start.sh`](../../../apps/codesearch/start.sh): Zoekt + API). `pnpm dev:infra` must not require app secrets such as `AUTH_SECRET`.

2. **Small-scale production / self-hosted deploy** — one command brings up production images (backend, UI, codesearch, OpenWorkflow worker) with internal Docker networking, without bind mounts or `pnpm dev` / portless.

Legacy Compose had containerized dev commands and removed `Dockerfile.dev` files; those workflows are incompatible with portless-wrapped dev scripts.

## Decision

1. **Profiles** (same file):

   - **`infra`** — `postgres`, `falkordb`, `infra-host-ports`, `otel-collector`, `agent-vault-dev` (Agent Vault for host-dev Docker sandboxes: API on `127.0.0.1:${CTXPIPE_AGENT_VAULT_API_HOST_PORT:-14321}`, proxy on `${CTXPIPE_AGENT_VAULT_PROXY_HOST_PORT:-14322}`; 2026-10-08). Used by **`pnpm dev:infra`** → `docker compose --profile infra up -d`. Local Zoekt is **not** a Compose service; it runs inside the codesearch Docker container during **`pnpm dev`** ([`scripts/codesearch-docker-dev.sh`](../../../scripts/codesearch-docker-dev.sh)).

   - **`deploy`** — Shared data services plus app containers: **`migrate`** (one-shot Drizzle migration via [`apps/backend/src/db/migrate.ts`](../../../apps/backend/src/db/migrate.ts)), **`backend`**, **`worker`**, **`ui`**, **`codesearch`**, plus Workspace chat sandboxes: **`agent-vault`** and the one-shot **`agent-vault-secrets`** (adds sandbox credentials; [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md)), **`dind`** (stock `docker:dind`, privileged, mutual TLS on 2376, config in [`scripts/sandbox-dind/`](../../../scripts/sandbox-dind/)) and the one-shot **`chat-sandbox-image`** (builds [`scripts/chat-sandbox`](../../../scripts/chat-sandbox/) inside `dind`; nothing waits for it). `dind`, `backend`, and `worker` share a separate **`sandbox`** network. Used by **`pnpm start`** → `docker compose --profile deploy up -d`. *(Updated 2026-10-03, PR 280 ticket 03.)* The sandbox design and its rejected options are in [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md).

2. **Dual-tagging** — `postgres` and `falkordb` use `profiles: [infra, deploy]` so they participate in both modes. They are **never published**: Docker routes to a container's published ports from other networks, chat sandboxes included. Host dev gets host ports from the infra-only **`infra-host-ports`** forwarder (socat) on the same `CTXPIPE_*` variables. **`otel-collector` is `infra` only** (contributor laptop collector). The **`deploy`** profile does not start it and does not set a collector URL. App containers export OTLP only when the operator sets `OTEL_EXPORTER_OTLP_*` (empty values are unset).

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
- Self-host chat sandboxes (`dind`, `chat-sandbox-image`): [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md).
