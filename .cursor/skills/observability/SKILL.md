---
name: observability
description: Find or add ctxpipe telemetry. Use for a request id, trace, log, metric, user, org, or job in HyperDX, Langfuse, or ClickHouse; for new spans, evlog fields, or metrics; or for localhost OTLP.
---

# Observability

Hosted stack: Railway project `ctxpipe-observability`. Human URLs, accounts, and MCP client setup: [`ops/observability/USING.md`](../../../ops/observability/USING.md). Naming history: [ADR-011](../../../.ai/memory/decisions/ADR-011-backend-observability-otel.md). Topology and retention: [ADR-038](../../../.ai/memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md). Self-host exporters: [`apps/docs/content/docs/self-hosting/(configuration)/configuration.mdx`](../../../apps/docs/content/docs/self-hosting/(configuration)/configuration.mdx).

## Find a signal

1. Take the id you have: response header `x-request-id` (`request.id`), a W3C `traceId`, `enduser.id` plus a time window, `ctxpipe.org.slug` / `ctxpipe.org.id`, or an OpenWorkflow job (`SpanName = openworkflow.job`, `ctxpipe.actor.type = job`).
2. Name the environment before searching. Hosted values are `production`, `pr-<digits>`, and `observability`. A laptop opt-in is `local-<name>`. Dashboards **ctxpipe Services** and **LLM (gen_ai)** open on `production`. Saved searches **Production logs**, **Production traces**, and **Production errors** are that same filter. **Request by id** and **Request by id (traces)** are not environment-scoped.
3. Read logs, traces, and metrics in HyperDX (MCP `hyperdx`, or the UI). Read LLM prompt and completion text in Langfuse (MCP `langfuse`). Read deploy status and process stdout in Railway (MCP `railway`) when the process exited before export.
4. Done when the failing span or log line is named, or the window is empty and the environment, service, and time range you used are written down.

### Keys

One key per concept. Resource attributes: `service.name` (`backend`, `openworkflow`, `codesearch`, `ui`), `service.namespace=ctxpipe`, `deployment.environment`. Scope names (`ctxpipe-backend`, `ctxpipe-codesearch`, `evlog`, `ctxpipe-genai`) are not `service.name`.

| Key | Where it is set |
| --- | --- |
| `request.id` | Incoming `x-request-id` when it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise a new UUID. Echoed on every response, including 5xx. |
| `traceId` / `spanId` | Active span, top-level on the evlog event so HyperDX `TraceId` fills. There is no `trace_id` attribute. |
| `enduser.id` | User id from auth. Omitted for actor `org_api_key`. |
| `ctxpipe.org.id` / `ctxpipe.org.slug` | Org from auth. |
| `ctxpipe.actor.type` | `user`, `org_api_key`, `oauth_client`, `webhook`, `job`. |
| `ctxpipe.api_key.id` | Key id. The secret is not an attribute. |
| `ctxpipe.oauth.client_id` | OAuth client id. |
| `ctxpipe.mcp.tool` | MCP tool name on that request. |
| `ctxpipe.conversation.id` | Conversation or thread id. |
| `ctxpipe.repository.id` / `ctxpipe.connection.id` | Present when the request or job input has them. |

HTTP on logs matches spans: `http.request.method`, `url.path` (no query string), `http.response.status_code` (this service's response). A call this service made uses `upstream.status_code`. `duration` on the wide event is milliseconds. Trace `Duration` is nanoseconds.

Langfuse metadata keeps its own names: `orgId`, `orgSlug`, `requestId`, `otelTraceId`, `environment`. Tags are `org:<slug>` and `env:<deployment.environment>`. Prompt text is on those Langfuse observations. The ClickHouse trace pipeline deletes `gen_ai.prompt*`, `gen_ai.completion*`, `gen_ai.input.messages`, `gen_ai.output.messages`, and `langfuse.observation.input` / `output`. Scope `ctxpipe-genai` is stored in ClickHouse and dropped from the Langfuse pipeline.

Browser `service.name=ui` posts to same-origin `/.otel`. `page_view` is an action. `console.log` / `info` / `warn` / `debug` are trace spans, not `otel_logs`. `otel.hyperdx_sessions` stays empty (`disableReplay: true`).

Rows already in ClickHouse keep the keys they were written with (`requestId`, `userId`, `environment`, `service.name=ctxpipe-codesearch`). New writes use the table above.

### HyperDX

UI: `https://hyperdx.ctxpipe.ai`. Connection **ctxpipe ClickHouse**. Sources: Logs `otel.otel_logs`, Traces `otel.otel_traces`, Metrics (gauge / sum / histogram / summary / exponential histogram), Sessions `otel.hyperdx_sessions` (empty).

Saved searches (upserted by `ops/observability/hyperdx/provision.ts`):

| Search | Source | Pin a single request |
| --- | --- | --- |
| Request by id | Logs | `LogAttributes['request.id'] = '<id>'`, read `TraceId` |
| Request by id (traces) | Traces | `SpanAttributes['request.id'] = '<id>'` |
| Production logs / traces / errors | Logs, Traces, Logs | `DeploymentEnvironment` / resource `deployment.environment` IN `production`. Errors add `SeverityText IN ('error')` |

Open the trace from `TraceId`. Sidebar field **DeploymentEnvironment** is the materialized column. In SQL, filter that column. A `ResourceAttributes['deployment.environment'] IN (...)` predicate is compiled to the attribute-array text index before the column rewrite.

| Dashboard | Answers | Default environment |
| --- | --- | --- |
| ctxpipe Services | Request rate, error rate, p95, slowest routes, log volume, recent error logs. Filters for org slug and `enduser.id`. | `production` |
| LLM (gen_ai) | Calls, error rate, input/output tokens, latency by model. | `production` |
| Observability Stack | Collector span/queue/log/metric rates, ClickHouse queries, inserts, memory, parts, Redis, `railway-telemetry` log count. | `observability` |
| Railway Infrastructure | CPU, memory, network rx/tx, disk. All environments, including `production`. | none |

HyperDX sleeps when idle. The first UI or MCP call wakes it. A cold start can fail once; retry. Sleep is a missing `railway.cpu` sample, not a zero.

### ClickHouse

Query through the HyperDX MCP (`clickstack_sql` and the builder tools). The database is not on the public internet. Official `mcp-clickhouse` needs `CLICKHOUSE_HOST` reachable from the MCP process; that is documented as unwired in USING.md.

Stay inside a few hours when iterating. `otel` parts older than 3 days sit on the cold bucket. A cold read fails when the bucket is down, bounded by `max_execution_time` 120s. `count()` over cold parts can still be answered from local metadata. Langfuse `traces`, `observations`, and `scores` move after 30 days and are not deleted; read them with `FINAL`.

```sql
SELECT Timestamp, ServiceName, SpanName, StatusCode, Duration, TraceId
FROM otel.otel_traces
WHERE Timestamp >= now() - INTERVAL 2 HOUR
  AND DeploymentEnvironment = 'production'
  AND ServiceName = 'backend'
  AND SpanAttributes['request.id'] = '<id>'
LIMIT 50
```

Time range first (daily partitions), then `DeploymentEnvironment`, then `ServiceName` or `TraceId`. Map lookups (`SpanAttributes`, `LogAttributes`) come after those. Select the columns you need.

| Table | Time column | Correlation |
| --- | --- | --- |
| `otel.otel_traces` | `Timestamp` | `TraceId`, `SpanId`, `ServiceName`, `SpanName`, `SpanKind`, `StatusCode`, `Duration`, `SpanAttributes`, `ResourceAttributes`, `DeploymentEnvironment` |
| `otel.otel_logs` | `Timestamp` | `TraceId`, `SpanId`, `SeverityText`, `Body`, `LogAttributes`, `ServiceName`, `DeploymentEnvironment` |
| `otel.otel_metrics_gauge` / `_sum` / `_histogram` / `_summary` / `_exponential_histogram` | `TimeUnix` | `MetricName`, `Value` (gauge and sum), `ResourceAttributes`, `DeploymentEnvironment` |
| `otel.otel_traces_kv_rollup_15m`, `otel.otel_logs_kv_rollup_15m` | rollup time | Facets. `DeploymentEnvironment` is not in the trace rollup's native facet set. |
| `langfuse.traces`, `langfuse.observations`, `langfuse.scores` | Langfuse time columns | LLM text. Not the `otel` database. |

`DeploymentEnvironment` is `ResourceAttributes['deployment.environment']`. The seed column `__hdx_materialized_deployment.environment.name` on `otel_logs` stays empty. Emit `deployment.environment` only.

### MCP

| Server | Use | Secret in the environment |
| --- | --- | --- |
| `hyperdx` | Logs, traces, metrics, dashboards, saved searches. `https://hyperdx.ctxpipe.ai/api/mcp`, `Authorization: Bearer <personal access key>`. | `HYPERDX_ACCESS_KEY` |
| `langfuse` | LLM traces, prompts, sessions. `${LANGFUSE_BASE_URL}/api/public/mcp` with `Authorization: Basic <base64(pk:sk)>`. Hosted base URL `https://langfuse.ctxpipe.ai`. | `LANGFUSE_BASE_URL`, `LANGFUSE_AUTH_STRING` |
| `railway` | Service status, deploys, runtime stdout. | Cursor OAuth |

`HYPERDX_ACCESS_KEY` is the personal key (Team Settings → API Keys). `HYPERDX_API_KEY` is the collector ingest token (`OTEL_EXPORTER_OTLP_HEADERS=authorization=<that key>`). They are not interchangeable. A wrong HyperDX key surfaces as HTTP 405 while the client tries OAuth. POST `https://hyperdx.ctxpipe.ai/api/mcp` without a key returns 401. The MCP was added in HyperDX 2.24.0; this stack runs `hyperdx/hyperdx:2` at 2.39.1 ([ClickStack MCP](https://clickhouse.com/docs/clickstack/mcp)). Rate limit is 600 requests per minute per key.

## Localhost OTLP

Export is off until `OTEL_EXPORTER_OTLP_*` is set. Host `pnpm dev` leaves it unset. A shell that points at an unreachable collector logs export errors; unset those variables for a quiet run.

`deployment.environment` is `RAILWAY_ENVIRONMENT_NAME` when that is non-empty, otherwise `production` when `NODE_ENV=production`, otherwise `development` (`otelDeploymentEnvironment` in `apps/backend/src/observability/otel.ts` and the codesearch copy). The app builds that resource in code. `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=...` does not set it.

### Laptop collector

`pnpm dev:infra` publishes the contrib collector on `127.0.0.1:4318` (`CTXPIPE_OTEL_COLLECTOR_HOST_PORT`). The receiver has no auth. Apps need no ingest key:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:4318/v1/metrics
OTEL_SERVICE_NAME=backend
```

`OTEL_SERVICE_NAME` is `backend`, `openworkflow`, or `codesearch` (the code default). An old example value `ctxpipe-backend` becomes `service.name` and misses the hosted dashboards.

The collector container exports to Better Stack and Langfuse (`apps/otel-collector/config.yaml`). `${env:BETTER_STACK_TOKEN}`, `${env:LANGFUSE_AUTH_STRING}`, and `${env:LANGFUSE_OTLP_ENDPOINT}` must be set or the process exits on env substitution. Compose treats `apps/otel-collector/.env` as optional. Those tokens belong to the collector, not the app. This compose file has no HyperDX. Spans land in Better Stack (full traces, logs, metrics) and Langfuse (allowlisted LLM spans only).

Cloud VMs use the same `pnpm dev:infra` collector. It still needs that env file to stay up.

### Shared collector (opt-in)

Send to `https://telemetry.ctxpipe.ai` only when a person holds the ingest key and wants this run in the hosted UI. It is never the default: the ClickHouse node is 1 GiB, Production searches assume `production`, and Langfuse stores prompt text.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://telemetry.ctxpipe.ai/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://telemetry.ctxpipe.ai/v1/logs
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://telemetry.ctxpipe.ai/v1/metrics
OTEL_EXPORTER_OTLP_HEADERS=authorization=<HYPERDX_API_KEY>
RAILWAY_ENVIRONMENT_NAME=local-<name>
OTEL_SERVICE_NAME=backend
```

`<name>` identifies the person or agent. It is not `production`, `pr-<digits>`, `observability`, or `development`. View it in HyperDX with `DeploymentEnvironment = local-<name>`, and in Langfuse under tag `env:local-<name>`. `local-*` uses the 60s metric reader, so a short process can exit before a gauge exports. Traces and logs flush on their own batch.

`ops/observability/docker-compose.yml` is a second full stack and needs the secrets in `ops/observability/.env.example`. Use it to work on the stack itself.

## Instrument

Add a span for a new I/O boundary, external call, job, or CPU stretch that has no span yet. The Hono server span, the outgoing `fetch` wrapper, and `dbTrace` already cover HTTP and Postgres. Add attributes on those spans when the fact belongs to the request or the query.

One span for a batch. A per-item loop or a hot path gets a count attribute on the batch span.

Name attributes from the key table, plus `ctxpipe.*` for a new product id of the same shape (stable, low-cardinality, no secret). Record `db.system.name`, `db.operation.name`, `db.collection.name`, `db.namespace`, and `db.query.text` (SQL text, capped at 2048 characters). Bound values stay off the span. `scrubDbError` strips Drizzle `params:` lines and pg `detail`, `where`, `internalQuery`, and `hint`.

Logs go through evlog: `getLogger()` or `log` from `apps/backend/src/observability/logger.ts` (codesearch has the same module). Wide events carry `step` and the attribution keys. `traceId` and `spanId` sit on the top level of the event. `stripLogPii` drops email, name, image, IP, and user-agent from the log body. The server span may still carry `user_agent.original`.

Metrics: a gauge for a current level (clients, depth, bytes in one sample). A monotonic counter for a cumulative count. HyperDX charts every OTLP Sum as `greatest(Value - previous, 0)`, so a level sent as a Sum draws as ~0. `ctxpipe.org.id` is a metric attribute only on `ctxpipe.advisor.calls`, `ctxpipe.ingestion.jobs`, and `ctxpipe.connector.syncs` (that counter also has `ctxpipe.connector.type` and `outcome`). Request ids, user ids, raw URLs, and unbounded strings are not metric attributes.

Tests sit next to the module (`*.test.ts`). Assert the attribute names and the absence of params, query strings, emails, and secrets. Export to a collector only when the change is the pipeline.

On public HTTP, copy attribution from the authenticated context (`applyAttribution`). Codesearch reads baggage because the backend is the only caller, and it forwards baggage only to internal origins (codesearch, `*.railway.internal`, localhost). Third-party fetches get `traceparent` only. URLs on spans are `scheme://host/path`. Credential path segments are `{token}` (`/reset-password/`) and `{invitation}` (`/public/invitations/`).

`RAILWAY_ENVIRONMENT_NAME` matching `pr-<digits>` uses `FlushOnDemandMetricReader` and `forceFlushOtel()` after the response or job. Production uses a 60s reader.

### Guards

- Load and synthetic traffic uses `local-<name>` or the laptop collector. `production`, `pr-<digits>`, and `observability` are for real traffic from those environments.
- Behavior lives in code. An env var is a secret, a URL, or an infra limit an operator sets.
- `apps/backend` and `apps/codesearch` log with evlog.

## Gotchas

- `@opentelemetry/sdk-node` auto-instrumentation does not patch `Bun.serve` or Bun's `fetch`. The server span is `backendOtelMiddleware`. The client span is `tracedOutgoingFetch`. Codesearch registers a `TracerProvider` itself and uses the same pattern.
- `instrumentation-pg`, `instrumentation-undici`, `instrumentation-net`, `instrumentation-dns`, and `instrumentation-fs` are disabled. Postgres spans come from `dbTrace`. A second client span from undici would replace `traceparent`.
- `DropParentlessAutoInstrumentationSpans` drops parentless CLIENT and INTERNAL spans whose scope starts with `@opentelemetry/instrumentation-`. ERROR status is kept. SERVER, CONSUMER, and `ctxpipe-backend` spans are kept.
- `BetterAuthSpanFilter` keeps a `better-auth` endpoint span only when its parent is a `/.auth/` server span. Hook, handler, middleware, and adapter `db *` spans are dropped. Postgres failures stay on `dbTrace`.
- OTLP `/v1/{traces,metrics,logs}` URLs are not instrumented.
- HyperDX sleeps. Collector, ClickHouse, Langfuse worker, and Redis stay up. Langfuse web and Mongo have Serverless on and stay up anyway. `railway-telemetry` is a 5-minute cron that exits.
- Worker idle traces (`write-to-clickhouse`, periodic runners) are a few spans per minute in `deployment.environment=observability`. `filter/ops_self_noise` drops health, mongo ping, and heartbeat spans on hyperdx and Langfuse unless status is ERROR. Product environments are unchanged.
- A PR flush exports after `span.end()`. An empty preview has no metric series until the next request or job.
- Cold `otel` parts: 3 days hot, delete at 390 days. Re-running a query over weeks can time out when it touches the bucket.
- Bun records `v8js.memory.heap.used` and `v8js.memory.heap.limit`. It does not emit `v8js.gc.duration`. OpenWorkflow on Node still records GC.
- Langfuse generations around 2026-09-25 05:00–07:00Z can count the same call twice (`ChatOpenAI` and `chat openai/gpt-5.6-terra`). `collapseRepeatedModelName` is the current write path.
