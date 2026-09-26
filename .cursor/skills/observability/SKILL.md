---
name: observability
description: Find or add ctxpipe telemetry. Use for a request id, trace, log, metric, user, org, or job in HyperDX, Langfuse, or ClickHouse; for new spans, evlog fields, or metrics; or for localhost OTLP.
---

# Observability

Hosted stack: Railway project `ctxpipe-observability`. URLs, accounts, dashboards, MCP clients, and laptop OTLP: [USING.md](../../../ops/observability/USING.md). Attribute history: [ADR-011](../../../.ai/memory/decisions/ADR-011-backend-observability-otel.md).

## Find a signal

1. Take the id you have: response header `x-request-id` (`request.id`), a W3C `traceId`, `enduser.id` plus a time window, `ctxpipe.org.slug` / `ctxpipe.org.id`, or an OpenWorkflow job (`SpanName = openworkflow.job`, `ctxpipe.actor.type = job`).
2. Name the environment: `production`, `pr-<digits>`, `observability`, or `local-<name>`. Dashboards and the shared filter: [USING.md](../../../ops/observability/USING.md#dashboards).
3. Read logs, traces, and metrics in HyperDX (MCP `hyperdx`). Read LLM prompt text in Langfuse (MCP `langfuse`). Read deploy status and stdout in Railway (MCP `railway`) when the process exited before export. URLs and keys: [USING.md](../../../ops/observability/USING.md#mcp).
4. Done when the failing span or log line is named, or the window is empty and the environment, service, and time range are written down.

Stay inside a few hours. `otel` parts older than 3 days sit on the cold bucket; a cold read fails within 120s when the bucket is down. Langfuse `traces`, `observations`, and `scores` move after 30 days and are not deleted; read them with `FINAL`.

```sql
SELECT Timestamp, ServiceName, SpanName, StatusCode, Duration, TraceId
FROM otel.otel_traces
WHERE Timestamp >= now() - INTERVAL 2 HOUR
  AND DeploymentEnvironment = 'production'
  AND ServiceName = 'backend'
  AND SpanAttributes['request.id'] = '<id>'
LIMIT 50
```

Time range first, then `DeploymentEnvironment`, then `ServiceName` or `TraceId`. Map lookups come after those. `Duration` is nanoseconds.

### Keys

One key per concept. Resource attributes: `service.name` (`backend`, `openworkflow`, `codesearch`, `ui`), `service.namespace=ctxpipe` on backend, codesearch, and the UI relay, `deployment.environment`. Scope names are not `service.name`.

`deployment.environment` on backend traces, metrics, and logs, the Langfuse environment tag, codesearch, and the UI relay is `RAILWAY_ENVIRONMENT_NAME` when that is set, otherwise `deployment.environment` from `OTEL_RESOURCE_ATTRIBUTES`, otherwise `production` when `NODE_ENV=production`, otherwise `development`.

| Key | Where it is set |
| --- | --- |
| `request.id` | Incoming `x-request-id` when it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise a new UUID. Echoed on every response. |
| `traceId` / `spanId` | Active span, top-level on the evlog event. There is no `trace_id` attribute. |
| `enduser.id` | User id from auth. Omitted for actor `org_api_key`. |
| `ctxpipe.org.id` / `ctxpipe.org.slug` | Org from auth. |
| `ctxpipe.actor.type` | `user`, `org_api_key`, `oauth_client`, `webhook`, `job`. |
| `ctxpipe.api_key.id` | Key id. The secret is not an attribute. |
| `ctxpipe.oauth.client_id` | OAuth client id. |
| `ctxpipe.mcp.tool` | MCP tool name on that request. |
| `ctxpipe.conversation.id` | Conversation or thread id. |
| `ctxpipe.repository.id` / `ctxpipe.connection.id` | Present when the request or job input has them. |

HTTP on logs matches spans: `http.request.method`, `url.path` (no query string), `http.response.status_code`. A call this service made uses `upstream.status_code`. Wide-event `duration` is milliseconds.

Langfuse metadata is `orgId`, `orgSlug`, `requestId`, and `environment`. Tags are `org:<slug>` and `env:<deployment.environment>`. Prompt text is on those observations. The ClickHouse pipeline deletes `gen_ai.prompt*`, `gen_ai.completion*`, `gen_ai.input.messages`, `gen_ai.output.messages`, and `langfuse.observation.input` / `output`.

Rows already stored may still use `requestId`, `userId`, or `environment`. New writes use the table above.

## Localhost OTLP

Export stays off until `OTEL_EXPORTER_OTLP_*` is set. `pnpm dev` leaves it unset. Laptop collector and the opt-in shared collector: [USING.md](../../../ops/observability/USING.md#localhost-telemetry). A shared export uses `RAILWAY_ENVIRONMENT_NAME=local-<name>` and is never the default.

## Instrument

Add a span for a new I/O boundary, external call, job, or CPU stretch that has no span yet. The Hono server span, the outgoing `fetch` wrapper, and `dbTrace` already cover HTTP and Postgres. One span for a batch; a per-item loop gets a count on that span.

Name attributes from the key table, plus `ctxpipe.*` for a new product id of the same shape. Record `db.system.name`, `db.operation.name`, `db.collection.name`, `db.namespace`, and `db.query.text` (SQL text, capped at 2048 characters). Bound values stay off the span.

Logs go through evlog (`getLogger()` or `log` from `observability/logger.ts`). Wide events carry `step` and the attribution keys, with `traceId` and `spanId` on the top level. Copy attribution from the authenticated context (lesson: telemetry attribution from auth). Codesearch reads inbound baggage because the backend is the only caller. The backend's `tracedOutgoingFetch` forwards baggage only to internal origins. Third-party fetches get `traceparent` only. URLs on spans are `scheme://host/path`.

Metrics: a gauge for a current level, a counter for a cumulative count.

`RAILWAY_ENVIRONMENT_NAME` matching `pr-<digits>` uses flush-on-demand and `forceFlushOtel()` after the response or job. Production uses a 60s reader.

Tests sit next to the module. Assert telemetry through the OTel SDK in-memory exporters and outbound calls through msw: attribute names present; params, query strings, emails, and secrets absent. Mocking rules: root AGENTS.md → Testing.

## Gotchas

- `@opentelemetry/sdk-node` does not patch `Bun.serve` or Bun's `fetch`. The server span is `backendOtelMiddleware`. The client span is `tracedOutgoingFetch`. pg, undici, net, dns, and fs auto-instrumentation is off; Postgres spans come from `dbTrace`.
- A PR flush exports after `span.end()`. An empty preview has no metric series until the next request or job.
- Under Bun there are no `v8js.*` runtime metrics.
- `CtxpipeCallbackHandler` (`observability/langfuse.ts`) collapses a repeated `model_name` before Langfuse records the generation.
