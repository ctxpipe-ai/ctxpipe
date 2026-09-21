# ADR-031: Self-hosted ClickStack + Langfuse (ops observability)

**Status:** Accepted | **Date:** 2026-09-21 | **Tags:** observability, railway, clickhouse, langfuse, hyperdx, otel

### Context

Hosted observability was Langfuse Cloud (paid) plus unused Better Stack / Amplitude free-tier. Product Railway `ctxpipe` clones every service into ~15 `pr-*` environments, so putting ClickHouse in that project would copy volumes and still could not share private DNS across environments. Amplitude had no funnels; we only needed page views and APM.

### Decision

1. **Separate Railway project** `ctxpipe-observability` (`has_pr_deploys = false`, region `us-east4-eqdc4a`). Internal ops tool in the OSS repo under [`ops/observability/`](../../../ops/observability/), not [`infra/module/ctxpipe`](../../../infra/module/ctxpipe) and not [`.github/workflows/deploy.yaml`](../../../.github/workflows/deploy.yaml).

2. **One small ClickHouse** (1 GiB cap, 10 GB volume, 14-day TTL) with databases `otel` (ClickStack) and `langfuse`. Langfuse Postgres stays on Neon; blobs on a Railway bucket. No replicas, no MinIO, no Railway Postgres.

3. **One ingest collector:** ClickStack (`clickhouse/clickstack-otel-collector`) with `CUSTOM_OTELCOL_CONFIG_FILE` adding `filter/llm_only` + `otlphttp/langfuse`. Apps still export OTLP once ([ADR-011](ADR-011-backend-observability-otel.md)). The product `otelcollector` service remains until cutover, then is removed. Fallback: contrib collector only — never two collectors.

4. **Prod + PR** send traces, logs, metrics, and LLM spans to the **public** collector (token header). Resource attr `deployment.environment` = `production` | `pr-N`. Langfuse tags `env:production` / `env:pr-N`.

5. **PR metrics** use `FlushOnDemandMetricReader` (no 60s timer) + `forceFlushOtel()` after Hono requests and OpenWorkflow `withLogger` jobs. Production keeps `PeriodicExportingMetricReader` at 60s.

6. **Browser:** `@hyperdx/browser` with `url` = same-origin `/.otel` (or operator collector). `disableReplay: true`. SPA `page_view` via `HyperDX.addAction`. [ADR-017](ADR-017-amplitude-analytics.md) is superseded.

7. **Deploy path:** [`.github/workflows/observability.yaml`](../../../.github/workflows/observability.yaml) on `ops/observability/**` changes to `main`, GitHub Environment `observability`, project token `OBSERVABILITY_RAILWAY_TOKEN`. Product Terraform `otel_otlp_endpoint` / `otel_otlp_headers` are optional until cutover.

### Consequences

**Positive**

- One billable APM + LLM stack (~$25–35/mo target) instead of Langfuse Cloud.
- Self-hosters copy `ops/observability` or point `OTEL_EXPORTER_OTLP_*` at any collector.
- PR Serverless can sleep: no periodic metric export, no per-env collector.

**Negative / trade-offs**

- Single-node ClickHouse: crash loses ingest until restart; 14-day TTL is the retention story.
- Cross-project OTLP is public + token (private networking does not cross Railway projects/environments).
- First-time Railway service create is manual; the Action only redeploys.

### Alternatives Considered

- **ClickStack inside `ctxpipe`:** Rejected — PR volume clones and no cross-env private DNS.
- **Keep Amplitude:** Rejected — no funnels; `@hyperdx/browser` is OTEL and operator-pointable.
- **Periodic metrics on PR:** Rejected — 60s export prevents Railway sleep.
- **Custom MetricReader in production:** Rejected — always-on prod wants the 60s periodic reader.
