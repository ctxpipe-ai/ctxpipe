# ADR-031: Self-hosted ClickStack + Langfuse (ops observability)

**Status:** Accepted | **Date:** 2026-09-21 | **Tags:** observability, railway, clickhouse, langfuse, hyperdx, otel

### Context

Hosted observability was Langfuse Cloud (paid) plus unused Better Stack / Amplitude free-tier. Product Railway `ctxpipe` clones every service into ~15 `pr-*` environments, so putting ClickHouse in that project would copy volumes and still could not share private DNS across environments. Amplitude had no funnels; we only needed page views and APM.

### Decision

1. **Separate Railway project** `ctxpipe-observability` (`has_pr_deploys = false`, region `us-east4-eqdc4a`). Internal ops tool in the OSS repo under [`ops/observability/`](../../../ops/observability/), not [`infra/module/ctxpipe`](../../../infra/module/ctxpipe) and not [`.github/workflows/deploy.yaml`](../../../.github/workflows/deploy.yaml).

2. **One small ClickHouse** (1 GiB cap, volume, 14-day TTL) with databases `otel` (ClickStack) and `langfuse`. Langfuse Postgres is a **dedicated `langfuse` database** on the existing Neon `ctxpipe` project (same compute; not a new Neon project). A schema on `neondb` is rejected — Langfuse Prisma migrations hardcode `public`. Blobs on Railway bucket `langfuse-events`. No replicas, no MinIO, no Railway Postgres.

3. **One ingest collector:** ClickStack (`clickhouse/clickstack-otel-collector`) with `CUSTOM_OTELCOL_CONFIG_FILE` adding `filter/llm_only` + `otlphttp/langfuse`. Apps still export OTLP once ([ADR-011](ADR-011-backend-observability-otel.md)). The product `otelcollector` service remains until cutover, then is removed. Fallback: contrib collector only — never two collectors.

4. **Prod + PR** send traces, logs, metrics, and LLM spans to the **public** collector (token header). Resource attr `deployment.environment` = `production` | `pr-N`. Langfuse tags `env:production` / `env:pr-N`.

5. **PR metrics** use `FlushOnDemandMetricReader` (no 60s timer) + `forceFlushOtel()` after Hono requests and OpenWorkflow `withLogger` jobs. Production keeps `PeriodicExportingMetricReader` at 60s.

6. **Browser:** `@hyperdx/browser` with `url` = same-origin `/.otel` (or operator collector). `disableReplay: true`. SPA `page_view` via `HyperDX.addAction`. [ADR-017](ADR-017-amplitude-analytics.md) is superseded.

7. **Deploy path:** Terraform in [`ops/observability/terraform/`](../../../ops/observability/terraform/) targets the existing Railway project `305aa114-c6f3-4aca-b883-0faa9c331aa2` (does not create it). ClickHouse and the collector use the **Railway GitHub integration** (`source_repo` + `root_directory`); image services pull public images. No static `OBSERVABILITY_RAILWAY_TOKEN`. [`.github/workflows/observability.yaml`](../../../.github/workflows/observability.yaml) only validates Terraform. Apply is manual. Public collector hostname is `telemetry.ctxpipe.ai`. Public HyperDX dashboard hostname is `hyperdx.ctxpipe.ai`. Public Langfuse hostname is `langfuse.ctxpipe.ai`. Product Terraform `otel_otlp_endpoint` / `otel_otlp_headers` stay optional until cutover. `LANGFUSE_INIT_*` pre-creates the Langfuse project + API keys so the collector can fan out on first boot. **Ingest stays awake** (`collector`, `clickhouse` — production 60s metrics). **UIs and sidecars sleep:** HyperDX + Mongo (idle Mongo pool; HyperDX cloud OTEL and in-process alert cron off), Langfuse web (Prisma `connection_limit=1&keepalives=0` + Neon `idle_session_timeout` + `REDIS_SOCKET_TIMEOUT_MS=0` + Node `setKeepAlive(false)` preload), Redis, and Langfuse worker as a **5-minute cron + `timeout -s KILL 90`** (not a 24/7 consumer). LLM rows in Langfuse can lag up to ~5 minutes.

### Consequences

**Positive**

- One billable APM + LLM stack (~$25–35/mo target) instead of Langfuse Cloud.
- Self-hosters copy `ops/observability` or point `OTEL_EXPORTER_OTLP_*` at any collector.
- PR Serverless can sleep: no periodic metric export, no per-env collector.

**Negative / trade-offs**

- Single-node ClickHouse: crash loses ingest until restart; 14-day TTL is the retention story.
- Cross-project OTLP is public + token (private networking does not cross Railway projects/environments).
- First apply is manual `terraform apply` plus one Railway bucket (`langfuse-events`) the 0.6.1 provider cannot create. DNS for `telemetry.ctxpipe.ai`, `hyperdx.ctxpipe.ai`, and `langfuse.ctxpipe.ai` is operator-owned. The Railway Terraform provider 0.6.1 cannot set Serverless sleep or cron; GitHub-built ingest services set `sleepApplication` in `railway.toml`. Image-service sleep and the Langfuse worker cron/`timeout` start command are set on the Railway service.
- Langfuse isolation is a second database on the existing Neon project, not a schema.
- Production 60s metrics keep the collector and ClickHouse awake by design. HyperDX/Mongo/Langfuse/Redis are the sleep set; the worker is cron+timeout so it cannot hold Redis/ClickHouse open between ticks. Product **PR** apps still use `FlushOnDemandMetricReader`.

### Alternatives Considered

- **ClickStack inside `ctxpipe`:** Rejected — PR volume clones and no cross-env private DNS.
- **Keep Amplitude:** Rejected — no funnels; `@hyperdx/browser` is OTEL and operator-pointable.
- **Periodic metrics on PR:** Rejected — 60s export prevents Railway sleep.
- **Custom MetricReader in production:** Rejected — always-on prod wants the 60s periodic reader.
- **Dedicated schema on `neondb`:** Rejected — Langfuse Prisma SQL hardcodes `public`; same Neon instance gets database `langfuse` instead.
- **Static `OBSERVABILITY_RAILWAY_TOKEN` + `railway up` Action:** Rejected — ClickHouse/collector deploy via Railway’s GitHub integration; the workspace token already used by `infra/` is enough for manual Terraform apply.
