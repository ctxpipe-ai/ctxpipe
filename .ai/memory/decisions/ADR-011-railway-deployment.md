# ADR-011: Railway Deployment

**Status:** Accepted  
**Date:** 2026-03-10  
**Tags:** deployment, railway, docker, infrastructure

## Context

We needed to deploy the ctxpipe monorepo (backend, UI, codesearch, OpenWorkflow worker) to a production environment. The local development stack uses Docker Compose with multiple services:

- `backend-bun`: Hono/Bun API server (port 3000)
- `ui-bun`: TanStack Start frontend (port 3002)
- `codesearch-bun`: Code search service with Zoekt (port 3001)
- `zoekt-webserver`: Zoekt search indexer (port 6070)
- `postgres`: PostgreSQL database
- `falkordb`: FalkorDB graph database

Key constraints:
1. Need managed PostgreSQL with backups
2. FalkorDB runs externally (not on Railway)
3. Codesearch and Zoekt need shared storage for search indexes
4. Want configuration-as-code (not dashboard-only setup)
5. Database migrations should run before new containers receive traffic

## Decision

Deploy to **Railway** with the following architecture:

### Services on Railway

| Service | Type | Dockerfile | Notes |
|---------|------|------------|-------|
| `backend` | Dockerfile | `apps/backend/Dockerfile` | Pre-deploy migrations, public API |
| `ui` | Dockerfile | `apps/ui/Dockerfile` | Private, proxied by backend |
| `codesearch` | Dockerfile | `apps/codesearch/Dockerfile` | Combined codesearch + zoekt-webserver |
| `worker` | Dockerfile | `apps/backend/Dockerfile.worker` | OpenWorkflow durable job worker |
| `postgres` | Railway Plugin | N/A | Managed PostgreSQL with backups |

### External Services

- **FalkorDB**: External provider via `GRAPH_DB_URI` environment variable

### Key Technical Choices

1. **Combined codesearch + zoekt**: Since Railway volumes can only attach to one service, we run both the Bun codesearch API and the Go zoekt-webserver in a single container. The `start.sh` script manages both processes.

2. **Pre-deploy migrations**: Database migrations run via Railway's `preDeployCommand` before traffic routes to new containers, ensuring zero-downtime schema updates.

3. **Configuration-as-code**: All service definitions live in `railway.toml` at repo root, with environment variables for service discovery (e.g., `${{Postgres.DATABASE_URL}}`).

4. **Bun for runtime**: All services use `oven/bun:1.2-alpine` for consistency with local development.

### File Changes

- `railway.toml`: Service definitions, pre-deploy hooks, restart policies
- `apps/codesearch/Dockerfile`: 3-stage build (Go binaries → Bun deps → runtime)
- `apps/codesearch/start.sh`: Process manager for zoekt-webserver + Bun server
- `apps/codesearch/src/config/paths.ts`: `ZOEKT_WEBSERVER_URL` now env-configurable
- `apps/backend/Dockerfile.worker`: New worker-only image for OpenWorkflow
- `apps/backend/Dockerfile`: Removed migrations from CMD (now in pre-deploy)

## Rationale/Consequences

**Benefits:**
- Managed PostgreSQL with automated backups (Railway plugin)
- Configuration-as-code via `railway.toml` (version controlled, reviewable)
- Pre-deploy migrations prevent schema mismatch during deploys
- Combined codesearch service simplifies volume management
- Consistent Bun runtime across all services

**Trade-offs:**
- Codesearch and Zoekt cannot scale independently (same container)
- FalkorDB requires external provider (not managed by Railway)
- Railway volumes are single-attachment (worked around via combined service)

## Alternatives Considered

### 1. Separate zoekt-webserver service
Attempted to deploy zoekt-webserver as a separate Railway service, but Railway volumes can only mount to one service at a time. Would require:
- Network-attached storage (complex)
- S3-style object storage for indexes (would need to modify Zoekt)

**Rejected**: Too complex for current needs. Combined service is simpler and sufficient.

### 2. Docker Compose in production
Run the same `docker-compose.yml` on a VPS or EC2 instance.

**Rejected**: Loses Railway's managed Postgres, auto-deploy from Git, and built-in observability.

### 3. Kubernetes (EKS/GKE)
Full container orchestration with persistent volumes, Helm charts, etc.

**Rejected**: Overkill for current scale. Railway's PaaS model provides sufficient power with less operational overhead.

### 4. Fly.io
Alternative PaaS with built-in persistent volumes.

**Rejected**: Team already familiar with Railway; similar capabilities.

## Notes

### Required Environment Variables

Each service needs these env vars (set via Railway dashboard or CLI):

**Backend:**
- `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
- `GRAPH_DB_URI`: External FalkorDB URL
- `AUTH_SECRET`: 32+ character random string
- `AUTH_BASE_URL`: Public backend URL
- `UI_PROXY_URL`: Private UI service URL
- `CODESEARCH_URL`: Private codesearch service URL

**UI:**
- `BACKEND_URL`: Public backend URL for SSR auth calls

**Codesearch:**
- `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
- `AUTH_SECRET`: Same as backend (JWT verification)
- `ZOEKT_WEBSERVER_URL`: `http://localhost:6070` (internal to container)
- `GITHUB_TOKEN`: Optional, for private repo access

### Deployment Order

1. Create Railway project
2. Add PostgreSQL plugin (creates `DATABASE_URL`)
3. Deploy services in order: backend → codesearch → worker → ui
4. Set environment variables for service discovery
5. Configure external FalkorDB provider

### Volume Configuration

Codesearch service needs a Railway volume mounted at `/data`:
- `/data/zoekt-index`: Zoekt search indexes
- `/data/repo-cache`: Cloned repository cache

See `railway.toml` for service definitions and `apps/codesearch/Dockerfile` for runtime configuration.
