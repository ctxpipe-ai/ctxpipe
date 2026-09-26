# Using the stack

How to read hosted telemetry and how to send a laptop or cloud-agent run into it. Topology, deploy, and cost live in [README.md](./README.md). Agents follow [`.cursor/skills/observability/SKILL.md`](../../.cursor/skills/observability/SKILL.md) (same file via `.agents/skills/`). Self-host exporters, not this project: [configuration](../../apps/docs/content/docs/self-hosting/(configuration)/configuration.mdx) and [operations](../../apps/docs/content/docs/self-hosting/(operations)/operations.mdx).

## URLs

| Surface | URL | What it is |
| --- | --- | --- |
| HyperDX | https://hyperdx.ctxpipe.ai | Logs, traces, metrics, dashboards |
| Langfuse | https://langfuse.ctxpipe.ai | LLM traces and prompt text |
| OTLP | https://telemetry.ctxpipe.ai | Public collector. Apps append `/v1/traces`, `/v1/logs`, `/v1/metrics` |

The collector expects `OTEL_EXPORTER_OTLP_HEADERS=authorization=<HYPERDX_API_KEY>`. That key is the ingest token on the collector service. It is not the HyperDX personal access key.

## Accounts

HyperDX: sign in on https://hyperdx.ctxpipe.ai. A personal API access key is under Team Settings → API Keys. That key is `HYPERDX_ACCESS_KEY` for MCP and for `bun ops/observability/hyperdx/provision.ts`.

Langfuse: https://langfuse.ctxpipe.ai, org `ctxpipe`, project `ctxpipe`. `AUTH_DISABLE_SIGNUP=true` on `langfuse/langfuse:3`. Existing users sign in with email and password. An invitation does not create an account. Someone with no user row needs that row created by an owner first; then an org-members invite applies. Org role `OWNER` is the admin. With no `project_memberships` row, Langfuse uses the org role. Project API keys (`pk` / `sk`) are what `LANGFUSE_AUTH_STRING` is: `base64(pk:sk)` with no newline (`echo -n 'pk:sk' | base64`).

## From a complaint to a trace

1. Copy `x-request-id` from the response, or the time, user, and org.
2. Set the environment. Hosted apps use `production` or `pr-<digits>`. The stack's own signals use `observability`. Dashboards **ctxpipe Services** and **LLM (gen_ai)** open on `production`. Clear that chip to see a preview or a `local-<name>` run.
3. In HyperDX, open saved search **Request by id** (logs) or **Request by id (traces)** and set the where clause to `LogAttributes['request.id'] = '<id>'` or `SpanAttributes['request.id'] = '<id>'`. Read `TraceId` and open the trace.
4. LLM prompt text is in Langfuse, tagged `org:<slug>` and `env:<environment>`, metadata `requestId` and `otelTraceId`. HyperDX stores the gen_ai span with prompt and completion attributes removed.
5. If the window is empty, check the environment chip, the service (`backend`, `openworkflow`, `codesearch`, `ui`), and whether HyperDX was asleep (first load wakes it; retry a cold 502). Process stdout that never exported is in Railway, observability project for this stack and the product project for app logs.

## Dashboards

Connection **ctxpipe ClickHouse**. Upsert from an operator shell (not Railway env):

```bash
HYPERDX_API_URL=https://hyperdx.ctxpipe.ai/api \
HYPERDX_ACCESS_KEY=… \
bun ops/observability/hyperdx/provision.ts
```

| Dashboard | What it answers | Opens on |
| --- | --- | --- |
| ctxpipe Services | Request rate, error rate, p95 latency, slowest routes, log volume by severity, recent error logs. Org slug and end-user filters. | `production` |
| LLM (gen_ai) | Call count, error rate, input tokens, output tokens, latency by model. | `production` |
| Observability Stack | Collector throughput and queue, ClickHouse queries, inserts, memory, MergeTree parts, Redis, railway-telemetry log count. | `observability` |
| Railway Infrastructure | CPU and memory versus limit, network rx/tx, disk. Includes every environment. | no default |
| Product usage | DAU/WAU/MAU, the same series for MCP, and stickiness across web and MCP. Definitions: [hyperdx/dashboards/product-usage.md](hyperdx/dashboards/product-usage.md). | `production` |

Sessions charts stay empty while browser replay is off.

## Saved searches

| Name | Source |
| --- | --- |
| Request by id | Logs, `LogAttributes['request.id'] != ''`, selects `TraceId` |
| Request by id (traces) | Traces, `SpanAttributes['request.id'] != ''` |
| Production logs | Logs, `deployment.environment` IN `production` |
| Production traces | Traces, same |
| Production errors | Logs, production and `SeverityText IN ('error')` |

The team Shared Filter field is `ResourceAttributes['deployment.environment']`, with no value pinned. Hand-written SQL should still filter the time range first (daily partitions), then the materialized column `DeploymentEnvironment`, then `ServiceName` or `TraceId`. A map `IN` on `ResourceAttributes['deployment.environment']` uses the attribute-array text index instead of that column. Dashboard chips use the map expression so they match the shared filter.

## Environment filter

HyperDX 2.39.1 has no team setting that defaults every search to `production`. The product dashboards above restore `production` when they load. **Railway Infrastructure** does not. Shared Filters list `ResourceAttributes['deployment.environment']` with no value pinned, so the checkboxes are whatever the time range contains. A pinned value of only `production` hides `pr-N` and `observability` rows. Personal pins live in the browser (`localStorage`) and are not set by the server. Terraform `DEFAULT_SOURCES` highlights that attribute on a new team; it does not set the shared filter.

## MCP

Repo config: [`.cursor/mcp.json`](../../.cursor/mcp.json). Cursor interpolates `${env:NAME}`.

| Server | URL | Header | Env |
| --- | --- | --- | --- |
| `hyperdx` | `https://hyperdx.ctxpipe.ai/api/mcp` | `Authorization: Bearer <HYPERDX_ACCESS_KEY>` | `HYPERDX_ACCESS_KEY` |
| `langfuse` | `https://langfuse.ctxpipe.ai/api/public/mcp` | `Authorization: Basic <LANGFUSE_AUTH_STRING>` | `LANGFUSE_BASE_URL=https://langfuse.ctxpipe.ai`, `LANGFUSE_AUTH_STRING` |
| `railway` | `https://mcp.railway.com` | Cursor OAuth | — |

POST `https://hyperdx.ctxpipe.ai/api/mcp` without a key returns 401. `https://hyperdx.ctxpipe.ai/api/api/mcp` is 404 (the public app strips one `/api`). The route has been in HyperDX since 2.24.0; this service is `hyperdx/hyperdx:2` at 2.39.1. Docs: [ClickStack MCP](https://clickhouse.com/docs/clickstack/mcp). Tools are prefixed `clickstack_`. The server allows 600 requests per minute per key. A wrong key often shows up as HTTP 405 while the client probes OAuth. Use the personal access key, not the ingest key.

**Claude Code** (user scope, secrets in the environment):

```bash
claude mcp add --transport http hyperdx https://hyperdx.ctxpipe.ai/api/mcp \
  --header "Authorization: Bearer ${HYPERDX_ACCESS_KEY}"
claude mcp add --transport http langfuse https://langfuse.ctxpipe.ai/api/public/mcp \
  --header "Authorization: Basic ${LANGFUSE_AUTH_STRING}"
```

**Cloud agents:** set Cursor secrets `HYPERDX_ACCESS_KEY`, `LANGFUSE_BASE_URL`, and `LANGFUSE_AUTH_STRING`. Railway MCP uses the Cursor OAuth session and may be absent in a headless run; HyperDX and Langfuse still answer with those three secrets. HyperDX's first call after idle wakes the service.

### ClickHouse MCP (not wired)

Official [`mcp-clickhouse`](https://github.com/ClickHouse/mcp-clickhouse) connects with `CLICKHOUSE_HOST`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` over the HTTP interface (`CLICKHOUSE_PORT=8123` and `CLICKHOUSE_SECURE=false` for plain HTTP). Our ClickHouse listens on `clickhouse.railway.internal:8123` inside the observability project. It has no public hostname.

| Option | Trade-off |
| --- | --- |
| HyperDX MCP `clickstack_sql` | Works today. The UI already holds the `otel` connection. ClickHouse stays private. Prefer the builder tools (`clickstack_search`, `clickstack_timeseries`, `clickstack_table`) for a single-source aggregation; raw SQL is the fallback. |
| Publish port 8123 | Gives `mcp-clickhouse` a host. Also gives the internet a database. Not done. |
| Operator tunnel (`railway connect` or a TCP proxy) plus a local stdio `mcp-clickhouse` | A laptop can query as the `otel` user. The password is the Railway `CLICKHOUSE_OTEL_PASSWORD`. Cloud agents cannot rely on that tunnel. Not in `mcp.json`. |

Query shape, when you do run SQL:

```sql
SELECT Timestamp, ServiceName, SpanName, StatusCode, Duration, TraceId
FROM otel.otel_traces
WHERE Timestamp >= now() - INTERVAL 2 HOUR
  AND DeploymentEnvironment = 'production'
  AND ServiceName = 'backend'
  AND SpanAttributes['request.id'] = '<id>'
LIMIT 50
```

`Duration` is nanoseconds. Log bodies are in `otel.otel_logs` (`SeverityText`, `Body`, `LogAttributes`, `TraceId`). Gauges and sums are `otel.otel_metrics_gauge` and `otel.otel_metrics_sum` (`MetricName`, `TimeUnix`, `Value`). Langfuse text is `langfuse.traces` / `observations` / `scores`, read with `FINAL`.

## Localhost telemetry

Leave `OTEL_EXPORTER_OTLP_*` unset unless this run needs a backend. `pnpm dev` does not set them. `deployment.environment` follows `RAILWAY_ENVIRONMENT_NAME`, then `NODE_ENV` (`production` or `development`).

**Laptop collector (no app secret).** `pnpm dev:infra` binds the contrib collector at `127.0.0.1:4318`. Point the app at `http://127.0.0.1:4318/v1/traces`, `/v1/logs`, and `/v1/metrics`. Omit `OTEL_EXPORTER_OTLP_HEADERS`. Set `OTEL_SERVICE_NAME` to `backend`, `openworkflow`, or `codesearch`.

The collector process prints OTLP to its own logs (`debug` exporter). It needs no env file. There is no local HyperDX in that compose file. Hosted views stay at https://hyperdx.ctxpipe.ai and https://langfuse.ctxpipe.ai when the app exports to `https://telemetry.ctxpipe.ai`.

**Shared collector (opt-in, never the default).** Use it when you want the hosted dashboards. The 1 GiB ClickHouse node and the Langfuse prompt store are the reason it stays opt-in.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://telemetry.ctxpipe.ai/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://telemetry.ctxpipe.ai/v1/logs
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://telemetry.ctxpipe.ai/v1/metrics
OTEL_EXPORTER_OTLP_HEADERS=authorization=<HYPERDX_API_KEY>
RAILWAY_ENVIRONMENT_NAME=local-<name>
OTEL_SERVICE_NAME=backend
```

`<name>` is the person or agent. Filter HyperDX to that `DeploymentEnvironment`. Langfuse tag is `env:local-<name>`. Cloud VMs use the same variables in the shell that starts Bun. Do not set them in the image or in `.env.local` that every agent inherits.

`local-*` is not a `pr-<digits>` environment, so metrics use the 60s reader. A process that exits immediately can miss gauges. Traces and logs use their batch exporters.

A full local ClickStack is `docker compose -f ops/observability/docker-compose.yml` after filling `ops/observability/.env` from `.env.example`. That is for working on this stack, and it needs those secrets.

## Retention

| Data | Hot (volume) | Then |
| --- | --- | --- |
| `otel` tables | 3 days | Cold bucket, delete after 390 days |
| `langfuse.traces`, `observations`, `scores` | 30 days, then cold | Kept |
| `system.query_log`, `system.error_log` | 3 days, local disk | Deleted, never moved |

A search older than the hot window reads the bucket. If the bucket is down, that query fails within 120 seconds. Recent rows still answer. `count()` can use local part metadata without reading the bucket.

## What agents record

The procedure, cardinality limits, and tests are in the [observability skill](../../.cursor/skills/observability/SKILL.md). Short form: span a new I/O, external call, job, or long CPU stretch; one span per batch; evlog wide events with ids from auth; gauges for levels and counters for cumulative counts; no secrets, query strings, prompt bodies, or SQL bound values.
