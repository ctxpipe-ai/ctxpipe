# ctxpipe-observability (ClickStack + Langfuse)

Internal ops stack. **Not** part of the product Railway project or [`infra/module/ctxpipe`](../../infra/module/ctxpipe). Hosted as Railway project `ctxpipe-observability` (`has_pr_deploys = false`, region `us-east4-eqdc4a`). Product apps (prod + every `pr-N`) send **OTLP HTTP** here.

See [ADR-031](../../.ai/memory/decisions/ADR-031-self-hosted-clickstack-langfuse.md).

## What runs

| Service | Image / build | Notes |
| --- | --- | --- |
| ClickHouse | [`clickhouse/`](./clickhouse/) (`clickhouse/clickhouse-server:26.8-alpine`) | 1 GiB RAM cap, 10 GB volume, DBs `otel` + `langfuse`, 14-day TTL |
| Collector | [`collector/`](./collector/) (`clickhouse/clickstack-otel-collector`) | Built-in ClickHouse APM + custom LLM allowlist → Langfuse |
| HyperDX | `hyperdx/hyperdx:2` | UI; Railway Serverless OK |
| Mongo | `mongo:7` | HyperDX metadata only |
| Langfuse web | `langfuse/langfuse:3` | Public UI + `/api/public/otel` |
| Langfuse worker | `langfuse/langfuse-worker:3` | ClickHouse + Neon + bucket |
| Redis | `redis:7-alpine` | Langfuse queue |

Postgres for Langfuse is **Neon** (existing project, scale-to-zero). Event blobs: **Railway Bucket**, not MinIO.

## Deploy (GitHub Action)

[`.github/workflows/observability.yaml`](../../.github/workflows/observability.yaml) runs on push to `main` when this folder (or the workflow) changes, plus `workflow_dispatch`.

**Once:**

1. Create Railway project `ctxpipe-observability` in the ctxpipe workspace. No GitHub PR-env integration. `has_pr_deploys = false`.
2. Create services named `clickhouse`, `collector`, `hyperdx`, `mongo`, `langfuse-web`, `langfuse-worker`, `redis`. Attach a **10 GB** volume to ClickHouse at `/var/lib/clickhouse`. Public domains only on collector (`:4318`), HyperDX, and Langfuse web.
3. Set service variables from [`.env.example`](./.env.example). Collector: `HYPERDX_API_KEY`, `CLICKHOUSE_*`, `LANGFUSE_OTLP_ENDPOINT`, `LANGFUSE_AUTH_STRING`. Product apps get the **public** collector URL + `OTEL_EXPORTER_OTLP_HEADERS=authorization=<HYPERDX_API_KEY>`.
4. GitHub Environment **`observability`**: secrets `OBSERVABILITY_RAILWAY_TOKEN` (project token, not the product `RAILWAY_TOKEN`) and `OBSERVABILITY_RAILWAY_PROJECT_ID`.
5. Point product Terraform `otel_otlp_endpoint` / `otel_otlp_headers` (and PR vars `OBSERVABILITY_OTLP_ENDPOINT` / `OBSERVABILITY_OTLP_HEADERS`) at the public collector. Until those are set, production still uses the in-project `otelcollector`.

[`deploy.sh`](./deploy.sh) links the project and `railway up`s ClickHouse + collector (repo Dockerfiles), then redeploys the image-only services.

## Local Compose

```bash
cp ops/observability/.env.example ops/observability/.env
# fill secrets
docker compose -f ops/observability/docker-compose.yml up -d --build
```

Product `pnpm dev:infra` still uses [`apps/otel-collector`](../../apps/otel-collector) for laptop Better Stack leftovers. Hosted ingest is this collector.

## Fallback

If the ClickStack image cannot merge `otlphttp/langfuse`, run only the contrib collector (`apps/otel-collector`) with a ClickHouse exporter. Never run two collectors.

## Cost target

Single replica, no PR copies, ~$25–35/mo. Uncapped ClickHouse or cloning this stack into `ctxpipe` preview envs is what blows the bill.
