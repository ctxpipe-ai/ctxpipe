# ADR-011: Backend Observability via OpenTelemetry and evlog

**Status:** Accepted | **Date:** 2026-03-12 | **Updated:** 2026-09-25 | **Tags:** backend, observability, opentelemetry, evlog

### Context

We need observability for the backend: APM (traces), LLM observability, and structured logs. Internal use targets **ClickStack / HyperDX** (logs, traces, metrics) and **self-hosted Langfuse** (LLM spans) in Railway project `ctxpipe-observability` ([ADR-038](ADR-038-self-hosted-clickstack-langfuse.md)). Self-hosting users may choose different tools (Jaeger, Grafana, Datadog, etc.). All configuration must be via environment variables.

### Decision

1. **OpenTelemetry for traces**: Use `@opentelemetry/sdk-node` with OTLP HTTP exporter. When `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, traces (including LangChain/LangGraph spans) are exported. LangChain/LangGraph spans come from `@langfuse/langchain` `CallbackHandler` passed via `runWithLangfuseContext` and `getLangfuseHandler()`, which emits gen_ai semantic conventions. No LangSmith tracing. No LangFuse env vars—spans flow through the existing OTLPTraceExporter.

2. **evlog for logs**: Use evlog with Hono middleware. When `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set, logs drain to OTLP via `createOTLPDrain` with batching and retry. Otherwise logs go to stdout only.

3. **Single endpoint, collector fan-out**: The app sends to one configurable OTLP endpoint per signal. For multiple backends, users run an OpenTelemetry Collector and configure it to fan out. **Hosted ingest** is the ClickStack collector with a merged custom file ([`ops/observability/collector/config.yaml`](../../../ops/observability/collector/config.yaml)): the **APM** path is the built-in ClickHouse exporter (full traces); the **LLM** path is `filter/llm_only` → Langfuse. [`apps/otel-collector/config.yaml`](../../../apps/otel-collector/config.yaml) remains the laptop / contrib reference. No app-side fan-out or LangFuse-specific env in the backend.

4. **Initialization order**: `parseEnv` → `initOtel` → `initEvlog` → `createApp`. OTEL must register before any code that creates spans.

5. **Register-first on Bun.** [`apps/backend/src/server.ts`](../../../apps/backend/src/server.ts) imports [`observability/register.ts`](../../../apps/backend/src/observability/register.ts) before the app, so `initOtel` runs before `createApp`. The Hono middleware [`backendOtelMiddleware`](../../../apps/backend/src/observability/http.ts) is the server span: it continues `traceparent` / `baggage`, names the span from the matched route, and returns `x-request-id` on every response including 5xx. Proxied UI assets (Vite modules and hashed files) skip that span and still set the header. A `fetch` wrapper creates the client span and injects W3C `traceparent`, because Bun's `fetch` is not undici. Baggage is added only for internal services (see attribution below). OTLP `/v1/{traces,metrics,logs}` URLs are left uninstrumented. Codesearch does not use `NodeSDK`. [`tracerProvider.register()`](../../../apps/codesearch/src/observability/otel.ts) runs before the app, then the same kind of Hono server span and fetch wrapper. `@opentelemetry/sdk-node` auto-instrumentations do not patch `Bun.serve` or Bun's global `fetch`.

6. **Attribution** ([`attribution.ts`](../../../apps/backend/src/observability/attribution.ts)). One set, ids only. Logs drop email, name, image, IP, and user-agent (`stripLogPii`). The server span may still carry `user_agent.original`.

   | Key | Meaning |
   | --- | --- |
   | `request.id` | Incoming `x-request-id` when it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise a new UUID. Echoed as the `x-request-id` response header. |
   | `traceId` / `spanId` | Active span, copied onto the evlog event as top-level fields. The OTLP drain maps those onto the log record. Nested-only attributes leave HyperDX `TraceId` empty. |
   | `enduser.id` | User id. Omitted for actor `org_api_key`. |
   | `ctxpipe.org.id` / `ctxpipe.org.slug` | Org id and slug. |
   | `ctxpipe.actor.type` | `user` \| `org_api_key` \| `oauth_client` \| `webhook` \| `job`. |
   | `ctxpipe.api_key.id` | Key id. The secret is not an attribute. |
   | `ctxpipe.oauth.client_id` | OAuth client id when that actor applies. |
   | `ctxpipe.mcp.tool` | MCP tool name when the request dispatches one. |
   | `ctxpipe.conversation.id` | Conversation or thread id. |
   | `ctxpipe.repository.id` / `ctxpipe.connection.id` | Set when the request or job input has them. |

   **Names.** One key per concept. Resource attributes are `service.name` (`backend`, `openworkflow`, `codesearch`, `ui`), `service.namespace=ctxpipe`, and `deployment.environment` (`production` | `pr-N` | `observability`). Not `deployment.environment.name`: ClickStack seeds `__hdx_materialized_deployment.environment.name` on `otel_logs` only, from that longer key, and the column stays empty. A materialized column whose name is the prefix of that seed is rejected. `DeploymentEnvironment` is materialized from `deployment.environment` on logs, traces, and metric tables, and the dashboards filter that expression. Do not also emit `.name`.

   evlog's wide event used to carry `environment`, `service`, `method`, `path`, and `status`. Those are not log attributes anymore. The OTLP resource has `deployment.environment` and `service.name`. HTTP fields on logs match spans: `http.request.method`, `url.path`, `http.response.status_code`. `duration` stays the evlog request duration in milliseconds. Trace duration is the `Duration` column (nanoseconds). `traceId` / `spanId` stay on the wide event only long enough for evlog to fill the `TraceId` / `SpanId` columns; they are removed from the JSON body. There is no `trace_id` attribute.

   `request.id`, `enduser.id`, `ctxpipe.org.id`, and `ctxpipe.org.slug` replace `requestId`, `userId` / `user.id`, `orgId`, and `orgSlug` on logs. The browser still sets HyperDX session keys `userId`, `teamId`, and `teamName`, and also sets `enduser.id`, `ctxpipe.org.id`, and `ctxpipe.org.slug` in the same call. Page-view actions keep `path` (the provider dedupes on it) and set `url.path` to the same pathname.

   Langfuse trace metadata stays `orgId`, `orgSlug`, `requestId`, `otelTraceId`, and `environment`. That is Langfuse's metadata schema. The span already has `ctxpipe.org.id`, `ctxpipe.org.slug`, `request.id`, and resource `deployment.environment`. `langfuse.environment` is the SDK's own attribute.

   Railway gauges use `service.name` (the Railway service name), `deployment.environment`, and `railway.project`, `railway.project.id`, `railway.service.id`, `railway.environment.id`, plus `railway.region` when the metrics API returns one. Environment-log resources omit `railway.region`: those lines have no region. Instrumentation scope names (`ctxpipe-backend`, `ctxpipe-codesearch`, `evlog`) are not `service.name`.

   Rows already in ClickHouse keep the keys they were written with. Rewriting `LogAttributes` / `SpanAttributes` maps would rebuild parts on a 1 GiB node, including cold storage, so there is no backfill.

   `applyAttribution` writes the active span, the request logger, and an in-process bag. A span processor copies that bag onto child spans. Outbound `fetch` to internal services (the configured codesearch URL origin, `*.railway.internal`, and localhost) carries the keys on W3C baggage. Third-party fetches get `traceparent` only: that header is a trace id and span id, so a peer that understands W3C can join the trace, and it does not include user, org, api-key, or conversation ids. Codesearch reads inbound baggage onto its spans and evlog events, and applies the same internal-only rule when it calls out.

   **Jobs.** Enqueue stores a `telemetry` object: `traceparent`, `request.id`, `enduser.id`, `ctxpipe.org.id`, `ctxpipe.org.slug`. The job payload's `orgId` and `orgSlug` overwrite that captured org. When the payload org differs and has no slug, the captured slug is dropped. `restoreJobTelemetry` starts an `openworkflow.job` consumer span, sets `ctxpipe.actor.type=job`, links the `traceparent`, then applies the payload's org, slug, connection, and repository ids over the captured bag. The caller's span does not receive the job's connection or repository id. Webhook requests set `ctxpipe.actor.type=webhook` on the route and add org and connection ids only after the signature check.

   **URLs.** Server spans and logs record the path with no query string. Client `url.full` is `scheme://host/path` (no query, no userinfo). Credential path segments become `{token}` (`/reset-password/`) or `{invitation}` (`/public/invitations/`), including inside wide events ([`secretPath.ts`](../../../apps/backend/src/observability/secretPath.ts)). The browser `/.otel` proxy ([`otelBrowserScrub.ts`](../../../apps/ui/src/lib/otelBrowserScrub.ts)) drops query, fragment, and userinfo from URL-shaped strings in the OTLP JSON, then applies the same two path rules, before the body is forwarded.

   **Browser exceptions.** React Query and mutation failures record a HyperDX exception with `ctxpipe.ui.source`, a static `ctxpipe.ui.key` when the first key segment is a name, and `ctxpipe.ui.http_status` when the error has one. Aborts are skipped. While session identity is still unknown, those errors stay in a buffer of 20 and flush when identity is set or after 10 seconds, with `ctxpipe.ui.deferred_ms` ([`hyperdxQueryErrors.ts`](../../../apps/ui/src/lib/hyperdxQueryErrors.ts)).

   **Langfuse.** `runWithLangfuseContext` passes `userId` (`enduser.id`, omitted for `org_api_key`), `sessionId` (`ctxpipe.conversation.id`), tags `org:<slug>` and `env:<deployment.environment>`, and trace metadata `orgId`, `orgSlug`, `requestId`, `otelTraceId`, `environment`.

   **Metrics stay low-cardinality.** `ctxpipe.org.id` is an attribute only on `ctxpipe.advisor.calls`, `ctxpipe.ingestion.jobs`, and `ctxpipe.connector.syncs` (that counter also has `ctxpipe.connector.type`). It is not on per-request series.

7. **PR flush-on-demand.** `RAILWAY_ENVIRONMENT_NAME` matching `pr-<digits>` uses `FlushOnDemandMetricReader` (no interval). Production uses `PeriodicExportingMetricReader` at 60s. On PR, the backend schedules `forceFlushOtel()` with `setTimeout` after `span.end()` and after the response is returned, and skips UI proxy paths. `withLogger` still flushes at the end of the job. `onForceFlush` exports whatever scope metrics `collect()` returned even when one observable callback threw (Bun `v8.getHeapSpaceStatistics` inside runtime-node). An empty collect that only has errors still throws. Codesearch uses the same reader and calls `forceFlushOtel()` after its server span ends. See [ADR-038](ADR-038-self-hosted-clickstack-langfuse.md).

### Consequences

**Positive**

- OTEL-first; any OTLP-compatible backend works.
- Self-hosters configure via env; no code changes for different targets.
- evlog provides wide-event logging; OTLP drain enables log correlation with traces.

**Negative / trade-offs**

- Requires a collector for multi-backend setups (hosted: ClickStack ClickHouse + Langfuse allowlist).
- evlog drain adds a dependency. **Superseded:** "no new log calls yet—setup only." Request logs now carry the attribution keys and `traceId` / `spanId`.

### Alternatives Considered

- **SDK fan-out in app**: Multiple exporters from code. Rejected: env-driven config is simpler; collector handles auth per backend.
- **Filter traces per target**: Initially deferred in favor of “LangFuse filters on ingest.” **Superseded**: OTLP ingest still recorded infra noise; the **ClickStack custom file** (allowlist copied from `apps/otel-collector/config.yaml`) applies an **allowlist** on the LLM-bound trace pipeline only, while the APM pipeline stays full-fidelity.

### Notes

- See `apps/backend/src/observability/otel.ts`, `register.ts`, `http.ts`, `attribution.ts`, `jobTelemetry.ts`, `businessMetrics.ts`, `evlog.ts`, `langfuse.ts`, [`ops/observability/collector/config.yaml`](../../../ops/observability/collector/config.yaml) (hosted), and `apps/otel-collector/config.yaml` (laptop reference).
- Env vars: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`.
- LangFuse integration: `runWithLangfuseContext` wraps graph invocations and adds `env:<deployment>` tags; nodes call `getLangfuseHandler()` in callbacks.
- PR vs prod metric readers: [ADR-038](ADR-038-self-hosted-clickstack-langfuse.md).
