# Using the stack

How to read hosted telemetry and how to send a laptop into it. What runs and how it is deployed: [README.md](./README.md). Agents: [observability skill](../../.cursor/skills/observability/SKILL.md).

HyperDX: https://hyperdx.ctxpipe.ai. Langfuse: https://langfuse.ctxpipe.ai. OTLP: https://telemetry.ctxpipe.ai with `OTEL_EXPORTER_OTLP_HEADERS=authorization=<HYPERDX_API_KEY>` (the ingest token, not the personal access key).

## Accounts

HyperDX: sign in, then Team Settings → API Keys. That personal key is `HYPERDX_ACCESS_KEY` for MCP and for [provisioning](./hyperdx/README.md).

Langfuse: org `ctxpipe`, project `ctxpipe`. `AUTH_DISABLE_SIGNUP=true`. Existing users sign in with email and password. An invitation does not create an account; an owner creates the user row first, then invites. Org role `OWNER` is the admin. With no project membership, Langfuse uses the org role. `LANGFUSE_AUTH_STRING` is `base64(pk:sk)` with no newline (`echo -n 'pk:sk' | base64`).

## From a complaint to a trace

1. Copy `x-request-id`, or the time, user, and org.
2. Set the environment. Hosted apps use `production` or `pr-<digits>`. This stack uses `observability`. A laptop opt-in is `local-<name>`. Dashboards that default to `production` are listed below. Clear that chip to see a preview or a local run.
3. Open saved search **Request by id** (logs) or **Request by id (traces)** and set the where clause to `LogAttributes['request.id'] = '<id>'` or `SpanAttributes['request.id'] = '<id>'`. Read `TraceId` and open the trace.
4. LLM prompt text is in Langfuse, tagged `org:<slug>` and `env:<environment>`, metadata `requestId` and `otelTraceId`. HyperDX stores the gen_ai span with prompt and completion attributes removed.
5. If the window is empty, check the environment chip and the service (`backend`, `openworkflow`, `codesearch`, `ui`). The first HyperDX load after idle wakes it. Process stdout that never exported is in Railway.

## Dashboards

Connection **ctxpipe ClickHouse**. Upsert from an operator shell: [hyperdx/README.md](./hyperdx/README.md).

| Dashboard | What it answers | Opens on |
| --- | --- | --- |
| ctxpipe Services | Request rate, error rate, p95, slowest routes, log volume, recent errors | `production` |
| LLM (gen_ai) | Call count, error rate, tokens, latency by model | `production` |
| Observability Stack | Collector, ClickHouse, and railway-telemetry | `observability` |
| Railway Infrastructure | CPU, memory, network, disk, every environment | no default |
| Product usage | DAU/WAU/MAU, MCP, stickiness. [definitions](./hyperdx/dashboards/product-usage.md) | `production` |

Sessions charts stay empty while browser replay is off.

Saved searches: **Request by id** (logs, selects `TraceId`), **Request by id (traces)**, **Production logs**, **Production traces**, **Production errors** (`SeverityText IN ('error')`). Production searches filter `ResourceAttributes['deployment.environment'] IN ('production')`.

Hand-written SQL filters `DeploymentEnvironment`. Dashboard chips use the map expression. Filter behavior: [hyperdx/README.md](./hyperdx/README.md#environment-filter).

## MCP

Repo config: [`.cursor/mcp.json`](../../.cursor/mcp.json).

| Server | URL | Header | Secret |
| --- | --- | --- | --- |
| `hyperdx` | `https://hyperdx.ctxpipe.ai/api/mcp` | `Authorization: Bearer <HYPERDX_ACCESS_KEY>` | `HYPERDX_ACCESS_KEY` |
| `langfuse` | `https://langfuse.ctxpipe.ai/api/public/mcp` | `Authorization: Basic <LANGFUSE_AUTH_STRING>` | `LANGFUSE_AUTH_STRING` |
| `railway` | `https://mcp.railway.com` | Cursor OAuth | — |

`HYPERDX_ACCESS_KEY` is the personal key. `HYPERDX_API_KEY` is the ingest token. A wrong HyperDX key often shows up as HTTP 405 while the client probes OAuth.

```bash
claude mcp add --transport http hyperdx https://hyperdx.ctxpipe.ai/api/mcp \
  --header "Authorization: Bearer ${HYPERDX_ACCESS_KEY}"
claude mcp add --transport http langfuse https://langfuse.ctxpipe.ai/api/public/mcp \
  --header "Authorization: Basic ${LANGFUSE_AUTH_STRING}"
```

Cloud agents need `HYPERDX_ACCESS_KEY` and `LANGFUSE_AUTH_STRING`. Railway MCP uses Cursor OAuth and may be absent headless. HyperDX's first call after idle wakes the service.

ClickHouse has no public hostname (`clickhouse.railway.internal:8123`). Query it through HyperDX `clickstack_*`. Publishing port 8123 is not done.

## Localhost telemetry

Leave `OTEL_EXPORTER_OTLP_*` unset unless this run needs a backend. `pnpm dev` does not set them. `deployment.environment` follows `RAILWAY_ENVIRONMENT_NAME`, then `NODE_ENV`.

**Laptop collector.** `pnpm dev:infra` binds `127.0.0.1:4318`. Point the app at `http://127.0.0.1:4318/v1/traces`, `/v1/logs`, and `/v1/metrics`. Omit the headers. `OTEL_SERVICE_NAME` is `backend`, `openworkflow`, or `codesearch`. The collector prints OTLP to its own logs. There is no local HyperDX.

**Shared collector (opt-in).** Use it when the hosted dashboards should show this run. The 1 GiB ClickHouse node and the Langfuse prompt store are why it stays opt-in.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://telemetry.ctxpipe.ai/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://telemetry.ctxpipe.ai/v1/logs
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://telemetry.ctxpipe.ai/v1/metrics
OTEL_EXPORTER_OTLP_HEADERS=authorization=<HYPERDX_API_KEY>
RAILWAY_ENVIRONMENT_NAME=local-<name>
OTEL_SERVICE_NAME=backend
```

`<name>` is the person or agent. Filter HyperDX to that environment. Langfuse tag is `env:local-<name>`. Set these in the shell that starts the process. `local-*` uses the 60s metric reader, so a process that exits immediately can miss gauges.

## Retention

| Data | Hot (volume) | Then |
| --- | --- | --- |
| `otel` tables | 3 days | Cold bucket, delete after 390 days |
| `langfuse.traces`, `observations`, `scores` | 30 days, then cold | Kept |
| `system.query_log`, `system.error_log` | 3 days, local disk | Deleted |

A search older than the hot window reads the bucket. If the bucket is down, that query fails within 120 seconds. `count()` can use local part metadata. Detail: [clickhouse/README.md](./clickhouse/README.md).
