# ctxpipe-observability (ClickStack + Langfuse)

Internal ops stack. **Not** part of the product Railway project or [`infra/module/ctxpipe`](../../infra/module/ctxpipe). Hosted as Railway project `ctxpipe-observability` (`305aa114-c6f3-4aca-b883-0faa9c331aa2`, `has_pr_deploys = false`, region `us-east4-eqdc4a`). Product apps in `production` and every `pr-N` send **OTLP HTTP** here when `OTEL_EXPORTER_OTLP_*` is set.

See [ADR-038](../../.ai/memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md).

## What runs

| Service | Source | Notes |
| --- | --- | --- |
| ClickHouse | GitHub `ops/observability/clickhouse` | Stay awake. 1 GiB RAM cap, volume, DBs `otel` + `langfuse`, 14-day TTL. System logs removed; `query_log` and `error_log` TTL 3 days |
| Collector | GitHub `ops/observability/collector` | Stay awake. Built-in ClickHouse APM + custom LLM allowlist → Langfuse. Scrapes its own `:8888` and ClickHouse `:9363` (keep-list). No redis receiver. Public hostname `telemetry.ctxpipe.ai` |
| HyperDX | `hyperdx/hyperdx:2` | Sleeps when unused. UI at `hyperdx.ctxpipe.ai`. Traces and logs to the private collector; metrics exporter `none`. Alert cron off (`RUN_SCHEDULED_TASKS_EXTERNALLY`) |
| Mongo | `mongo:7` | Sleeps after HyperDX idles. HyperDX metadata only. Not scraped |
| Langfuse web | `langfuse/langfuse:3` | Sleeps when unused. UI at `langfuse.ctxpipe.ai` + `/api/public/otel`. Traces only, to the private collector. Wakes on dashboard or LLM OTLP |
| Langfuse worker | `langfuse/langfuse-worker:3` | Always-on Redis consumer (stock image CMD). Does not sleep. Traces only; sampler configured at 1% (`OTEL_TRACES_SAMPLER_ARG=0.01`) and was still ~60 spans/minute on 2026-09-25 |
| Redis | `redis:7-alpine` | Stays up while the worker is running. Metrics come from `railway-telemetry` `INFO`, not a collector receiver |
| railway-telemetry | GitHub `ops/observability/railway-telemetry` | Cron `*/5`, then exit. Railway CPU/memory/network/disk, observability environment logs, Redis `INFO`. Needs `RAILWAY_API_TOKEN` |

`ops-probe` is **not** part of this stack. It is a temporary Railway service (not in Terraform) and will be deleted.

## Signals

| Signal | From | Notes |
| --- | --- | --- |
| Traces, logs, metrics | Product backend, openworkflow, codesearch | Public OTLP when `OTEL_EXPORTER_OTLP_*` is set. `deployment.environment` is `production` or `pr-N`. PR uses flush-on-demand; production uses a 60s reader. Empty product `otel_otlp_endpoint` still uses the in-project `otelcollector` |
| LLM spans | Same apps, `filter/llm_only` | Langfuse, header `x-langfuse-ingestion-version: 4`. Tags `env:production` / `env:pr-N` |
| Browser | `@hyperdx/browser` via same-origin `/.otel` | `service.name=ui`. `disableReplay: true`. `consoleCapture` writes trace spans, not `otel_logs`. `hyperdx_sessions` stays empty (rrweb required) |
| Collector + ClickHouse | `prometheus/self` every 60s | `service.name` `otel-collector` and `clickhouse`, `deployment.environment=observability`. ClickHouse series are keep-listed |
| HyperDX | Activity | Traces and logs to the private collector. No metric timer |
| Langfuse web / worker | Activity | Traces only, private collector. No metric timer |
| Railway resources | `railway-telemetry` | Gauges `railway.cpu.*`, `railway.memory.*`, `railway.network.rx` / `tx`, `railway.disk.usage`. Observability `production`, product `production`, and product `pr-*`. 5-minute window, 60s samples |
| Observability logs | `railway-telemetry` | `environmentLogs` for the observability project only (runtime stdout, not build logs) |
| Redis | `railway-telemetry` `INFO` | Gauges for levels (memory, clients, uptime, db keys). Sums for commands, keyspace, connections |

## Dashboards

HyperDX connection **`ctxpipe ClickHouse`**. Sources Logs, Traces, Metrics, Sessions. `DEFAULT_CONNECTIONS` / `DEFAULT_SOURCES` seed a new team that has none; they do not update an existing team.

Repo dashboards: **ctxpipe Services**, **Railway Infrastructure**, **Observability Stack**, **LLM (gen_ai)**. Upsert them (and the **Request by id** saved searches) from an operator shell. These variables are not Railway env:

```bash
HYPERDX_API_URL=https://hyperdx.ctxpipe.ai/api \
HYPERDX_ACCESS_KEY=… \
bun ops/observability/hyperdx/provision.ts
```

## Awake vs sleep

| Awake or scheduled | Sleeps when idle |
| --- | --- |
| collector, clickhouse, langfuse-worker, redis | hyperdx, mongo, langfuse-web |
| railway-telemetry cron (starts, exports, exits) | |

No periodic export and no poll against hyperdx, mongo, or langfuse-web. Collector scrapes only itself and ClickHouse. Redis stays up because the worker does. `RAILWAY_API_TOKEN` reads do not wake a service. Without the token the cron still exports Redis `INFO` and a WARN log, then exits 1.

Postgres for Langfuse is a **dedicated `langfuse` database** on the existing Neon `ctxpipe` project (same compute, not a new instance, not a schema on `neondb`). Event blobs: **Railway Bucket** `langfuse-events`, not MinIO.

## Deploy

Infrastructure lives in [`terraform/`](./terraform/). ClickHouse, the collector, and `railway-telemetry` rebuild when those folders change because Railway is connected to `ctxpipe-ai/ctxpipe` (GitHub integration). There is **no** static `OBSERVABILITY_RAILWAY_TOKEN`. `railway-telemetry` reads `RAILWAY_API_TOKEN` from Railway, not from Terraform.

[`.github/workflows/observability.yaml`](../../.github/workflows/observability.yaml) validates Terraform on changes under `ops/observability/**`. A same-repo pull request also runs `terraform plan` (GitHub Environment `terraform-plan`, never apply) and updates a comment headed `## Observability Terraform Plan`. `TF_VAR_github_repo_branch` is `main` on that plan and on apply, so the comment is the post-merge preview. Push to `main`, and `workflow_dispatch` from `main` only, init the R2 backend (`observability/terraform.tfstate`), pin `us-east4-eqdc4a`, plan, and apply. Applies use concurrency group `observability-apply` and are not cancelled when a newer run is queued. The plan guard refuses a delete or replace of any `railway_service`, `railway_custom_domain`, or `railway_variable_collection`, and any service volume change.

**Create GitHub Environment `observability` with required reviewers and a `main`-only deployment branch policy before merging.** `terraform-plan` exists and currently has no protection rules. If `observability` does not exist, the first push to `main` creates it with no rules and apply runs ungated. Treat a green, reviewed PR plan as the merge gate until that environment is protected.

Railway holds secret values. Terraform holds wiring and does not list those names, so apply cannot delete them. The workflow needs only the existing GitHub secrets `RAILWAY_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`, available to environments `terraform-plan` and `observability`.

| Service | Railway-owned (not in Terraform) | Terraform wires consumers with |
| --- | --- | --- |
| clickhouse | `CLICKHOUSE_OTEL_PASSWORD`, `CLICKHOUSE_LANGFUSE_PASSWORD` | — |
| collector | `HYPERDX_API_KEY`, `LANGFUSE_AUTH_STRING` | `CLICKHOUSE_PASSWORD` = `${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}` |
| hyperdx | — | `CLICKHOUSE_PASSWORD` and `DEFAULT_CONNECTIONS` password = `${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}`; `HYPERDX_API_KEY` = `${{collector.HYPERDX_API_KEY}}` |
| langfuse-web | `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `SALT`, `ENCRYPTION_KEY`, `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`, `LANGFUSE_INIT_USER_PASSWORD`, `LANGFUSE_INIT_USER_EMAIL` | `CLICKHOUSE_PASSWORD` = `${{clickhouse.CLICKHOUSE_LANGFUSE_PASSWORD}}`; `OTEL_EXPORTER_OTLP_HEADERS` = `authorization=${{collector.HYPERDX_API_KEY}}` |
| langfuse-worker | — | `DATABASE_URL`, `DIRECT_URL`, `SALT`, `ENCRYPTION_KEY` reference langfuse-web; `CLICKHOUSE_PASSWORD` references clickhouse; the same OTLP header reference |
| railway-telemetry | `RAILWAY_API_TOKEN` | `OTEL_EXPORTER_OTLP_HEADERS` = `authorization=${{collector.HYPERDX_API_KEY}}` |

`LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `SECRET_KEY` on langfuse-web must match collector `LANGFUSE_AUTH_STRING` (`base64(pk:sk)`) so the collector can fan out. `DATABASE_URL` and `DIRECT_URL` on langfuse-web must include `connection_limit=1&keepalives=0`. The worker references those variables, so it inherits the same URLs.

**Fresh project, once:** create the Railway services (Terraform or the dashboard), then set the Railway-owned names above on those four services before traffic. Terraform can apply the references first; Railway resolves them when the secret exists. Do not copy the secrets into GitHub.

**First plan:** R2 state is empty or partial because these services were created through the Railway API. [`terraform/imports.tf`](./terraform/imports.tf) adopts them. The first PR plan must show **imports and in-place updates only** — not creates of the existing services, and not a destroy or replace of `clickhouse` or `mongo`. Review that plan before merge. Import blocks do nothing once the address is in state. Service domains stay on the live hostnames (`collector-production-5b4c.up.railway.app`, `hyperdx-production-1172.up.railway.app`, `langfuse-web-production-f475.up.railway.app`); the first plan should not change them. The plan guard also refuses a service volume change, including null to set, and a delete or replace of a custom domain or variable collection. Custom domains stay `telemetry.ctxpipe.ai`, `hyperdx.ctxpipe.ai`, and `langfuse.ctxpipe.ai`. `railway_variable_collection` deletes a variable only when that name is in state and absent from config. The langfuse-web import id omits live-only `NODE_OPTIONS`, so apply does not delete it.

**Once:**

1. Railway project `ctxpipe-observability` already exists (`305aa114-c6f3-4aca-b883-0faa9c331aa2`). `has_pr_deploys = false`.
2. Create Neon database `langfuse` owned by role `langfuse` on the existing `ctxpipe` project (production branch). Do not put Langfuse tables in `neondb.public`.
3. Create Railway bucket `langfuse-events` (region `iad`) so `${{langfuse-events.BUCKET}}` and sibling references resolve. Provider 0.6.1 has no bucket resource, so this is not imported.
4. Set the Railway-owned secrets in the table above on the live services (already done for this project). `RAILWAY_API_TOKEN` must read the observability and product projects. Without it, `railway-telemetry` exports Redis only and exits 1. No new GitHub secrets.
5. Open a pull request that touches `ops/observability/**` and review the plan comment. Merge only when it is imports plus in-place updates.
6. Merge to `main`. The workflow pins the region, then applies. Terraform cannot Update regions (provider issue #77 + `ignore_changes`). Manual pin, if CI has not run:

   ```bash
   RAILWAY_PROJECT_ID=305aa114-c6f3-4aca-b883-0faa9c331aa2 \
   RAILWAY_SERVICE_SET=observability \
   RAILWAY_ENVIRONMENT=production \
   bash scripts/railway-set-regions.sh
   ```

   ClickHouse volume copy has downtime. Confirm both volumes are `us-east4-eqdc4a` before calling the stack done.
7. Create DNS CNAMEs for `telemetry.ctxpipe.ai`, `hyperdx.ctxpipe.ai`, and `langfuse.ctxpipe.ai` to `terraform output collector_dns_record` / `hyperdx_dns_record` / `langfuse_dns_record`. Until those are live, use the Railway service domains.
8. Point product Terraform `otel_otlp_endpoint` / `otel_otlp_headers` (and PR vars `OBSERVABILITY_OTLP_ENDPOINT` / `OBSERVABILITY_OTLP_HEADERS`) at `https://telemetry.ctxpipe.ai` with `authorization=<HYPERDX_API_KEY>`. Until those are set, production still uses the in-project `otelcollector`.

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

Single replica, no PR copies, ~$25–35/mo target. **Awake:** collector, ClickHouse (production 60s metrics), Langfuse worker, Redis (the worker holds it). **`railway-telemetry`** is a 5-minute cron that exits. **Sleep:** HyperDX, Mongo, Langfuse web. Uncapped ClickHouse or cloning this stack into `ctxpipe` preview envs is what blows the bill. ClickHouse is capped at 1 GiB: system logs removed, `query_log` / `error_log` kept 3 days, cache caps under that budget, Prometheus scrape keep-listed.

The Railway 0.6.1 provider cannot set `sleepApplication`. GitHub-built collector and ClickHouse set `sleepApplication = false` in `railway.toml`. The `railway-telemetry` cron is `railway.toml`, not a Terraform attribute. Image-service sleep, HyperDX `MONGO_URI` pool knobs, and HyperDX `OTEL_METRICS_EXPORTER=none` / `RUN_SCHEDULED_TASKS_EXTERNALLY` are set on the Railway service after apply. **Superseded:** `OTEL_SDK_DISABLED` on HyperDX (it blocked self-traces). Neon `langfuse` uses `idle_session_timeout=60s` and Prisma `connection_limit=1&keepalives=0`. Langfuse `REDIS_SOCKET_TIMEOUT_MS=0` disables the 30s reconnect watchdog.
