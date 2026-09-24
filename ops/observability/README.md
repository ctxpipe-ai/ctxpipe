# ctxpipe-observability (ClickStack + Langfuse)

Internal ops stack. **Not** part of the product Railway project or [`infra/module/ctxpipe`](../../infra/module/ctxpipe). Hosted as Railway project `ctxpipe-observability` (`305aa114-c6f3-4aca-b883-0faa9c331aa2`, `has_pr_deploys = false`, region `us-east4-eqdc4a`). Product apps (prod + every `pr-N`) send **OTLP HTTP** here.

See [ADR-031](../../.ai/memory/decisions/ADR-031-self-hosted-clickstack-langfuse.md).

## What runs

| Service | Source | Notes |
| --- | --- | --- |
| ClickHouse | GitHub `ops/observability/clickhouse` | 1 GiB RAM cap, volume, DBs `otel` + `langfuse`, 14-day TTL |
| Collector | GitHub `ops/observability/collector` | Built-in ClickHouse APM + custom LLM allowlist → Langfuse. Public hostname `telemetry.ctxpipe.ai` |
| HyperDX | `hyperdx/hyperdx:2` | UI at `hyperdx.ctxpipe.ai`; Railway Serverless OK |
| Mongo | `mongo:7` | HyperDX metadata only |
| Langfuse web | `langfuse/langfuse:3` | UI at `langfuse.ctxpipe.ai` + `/api/public/otel` |
| Langfuse worker | `langfuse/langfuse-worker:3` | ClickHouse + Neon + bucket |
| Redis | `redis:7-alpine` | Langfuse queue |

Postgres for Langfuse is a **dedicated `langfuse` database** on the existing Neon `ctxpipe` project (same compute, not a new instance, not a schema on `neondb`). Event blobs: **Railway Bucket** `langfuse-events`, not MinIO.

## Deploy

Infrastructure lives in [`terraform/`](./terraform/). ClickHouse and the collector rebuild when those folders change because Railway is connected to `ctxpipe-ai/ctxpipe` (GitHub integration). There is **no** static `OBSERVABILITY_RAILWAY_TOKEN`.

[`.github/workflows/observability.yaml`](../../.github/workflows/observability.yaml) only **validates** the Terraform. Apply is manual (`terraform apply` from `terraform/`).

**Once:**

1. Railway project `ctxpipe-observability` already exists (`305aa114-c6f3-4aca-b883-0faa9c331aa2`). `has_pr_deploys = false`.
2. Create Neon database `langfuse` owned by role `langfuse` on the existing `ctxpipe` project (production branch). Do not put Langfuse tables in `neondb.public`.
3. Create Railway bucket `langfuse-events` (region `iad`) so `${{langfuse-events.BUCKET}}` and sibling references resolve.
4. Copy [`terraform/terraform.tfvars.example`](./terraform/terraform.tfvars.example) → `terraform.tfvars`. Generate ClickHouse / HyperDX / Langfuse init secrets. `LANGFUSE_INIT_PROJECT_*` keys must match `langfuse_auth_string` so the collector can fan out on first boot.
5. `terraform apply` (use this PR branch for `github_repo_branch` until merge, then `main`).
6. Create DNS CNAMEs for `telemetry.ctxpipe.ai`, `hyperdx.ctxpipe.ai`, and `langfuse.ctxpipe.ai` to `terraform output collector_dns_record` / `hyperdx_dns_record` / `langfuse_dns_record`. Until those are live, use the Railway service domains.
7. Point product Terraform `otel_otlp_endpoint` / `otel_otlp_headers` (and PR vars `OBSERVABILITY_OTLP_ENDPOINT` / `OBSERVABILITY_OTLP_HEADERS`) at `https://telemetry.ctxpipe.ai` with `authorization=<HYPERDX_API_KEY>`. Until those are set, production still uses the in-project `otelcollector`.

[`deploy.sh`](./deploy.sh) is an optional CLI escape hatch (`railway up`) if the GitHub integration is unavailable.

## Local Compose

```bash
cp ops/observability/.env.example ops/observability/.env
# fill secrets
docker compose -f ops/observability/docker-compose.yml up -d --build
```

Product `pnpm dev:infra` still uses [`apps/otel-collector`](../../apps/otel-collector) for laptop leftovers. Hosted ingest is this collector.

## Fallback

If the ClickStack image cannot merge `otlphttp/langfuse`, run only the contrib collector (`apps/otel-collector`) with a ClickHouse exporter. Never run two collectors.

## Cost target

Single replica, no PR copies, Railway Serverless on every service, ~$25–35/mo. Uncapped ClickHouse or cloning this stack into `ctxpipe` preview envs is what blows the bill. The Railway 0.6.1 provider cannot set `sleepApplication`; GitHub-built services use `railway.toml`, image services are set on the Railway service.
