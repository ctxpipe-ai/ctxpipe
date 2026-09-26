# ADR-011: Backend Observability via OpenTelemetry and evlog

**Status:** Accepted | **Date:** 2026-03-12 | **Updated:** 2026-09-26 | **Tags:** backend, observability, opentelemetry, evlog

### Context

The backend needs traces, structured logs, and LLM spans. Hosted ingest is ClickStack / HyperDX plus self-hosted Langfuse ([ADR-038](ADR-038-self-hosted-clickstack-langfuse.md)). Self-hosters point the same exporters at their own collector. Configuration is environment variables.

### Decision

1. **Traces.** `@opentelemetry/sdk-node` exports OTLP HTTP when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. LLM spans come from the Langfuse LangChain `CallbackHandler` (`awaitHandlers` so a generation stays on the active span) inside `propagateAttributes` (`runWithLangfuseContext`). There is no LangSmith tracing and no app-side Langfuse exporter.

2. **Logs.** evlog on Hono. When `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set, logs drain through evlog's `createOTLPDrain` (5s timeout). Otherwise stdout.

3. **One endpoint per signal.** Fan-out is a collector's job. Hosted ingest keeps full traces in ClickHouse and sends LLM spans to Langfuse via `filter/llm_only` ([ADR-038](ADR-038-self-hosted-clickstack-langfuse.md)). [`apps/otel-collector`](../../../apps/otel-collector/config.yaml) is a laptop debug sink. The app does not fan out.

4. **Startup order.** `server.ts` imports `observability/register.ts` before the app. That module runs `parseEnv`, then `initOtel`, then `initEvlog`.

5. **Bun.** `@opentelemetry/sdk-node` does not patch `Bun.serve` or Bun's `fetch`. The server span is `@hono/otel` in `backendOtelMiddleware` (UI proxy paths skip the span and still return `x-request-id`). Outgoing `fetch` is wrapped so the client span exists and carries `traceparent`. The backend registers HTTP instrumentation (incoming ignored, outgoing requires a parent, OTLP URLs skipped), Redis with `requireParentSpan`, and Node runtime metrics only when the process is not Bun. Postgres spans come from `dbTrace`. Parentless client and internal auto-instrumentation spans are dropped unless status is ERROR. `better-auth` spans are dropped the same way. Codesearch uses `NodeTracerProvider` and `@hono/otel`, and copies inbound baggage because only our backend calls it.

6. **Names.** Ids from auth only; OTel semconv plus `ctxpipe.*`; `deployment.environment` (not `.name`); URLs without query strings; no backfill. Keys: [observability skill](../../../.cursor/skills/observability/SKILL.md).

7. **Preview metrics.** `RAILWAY_ENVIRONMENT_NAME` matching `pr-<digits>` selects `FlushOnDemandMetricReader` on the backend (no interval); `withLogger` and the HTTP middleware flush after the job or response. Production uses `PeriodicExportingMetricReader` at 60s. Codesearch exports no metrics on preview, so it has no periodic reader there.

### Consequences

- Any OTLP collector works. Self-hosters change env, not code.
- Multi-backend setups need a collector. Hosted ingest is ClickHouse plus the Langfuse allowlist.
- evlog wide events correlate with traces when the OTLP log drain is on.

### Alternatives Considered

- **SDK fan-out in the app.** Rejected. Env points at one endpoint; the collector owns per-backend auth.
- **Filter traces in the app, or rely on Langfuse to drop noise.** Rejected for hosted ingest. The ClickStack file allowlists the LLM pipeline; the APM pipeline stays full fidelity. The laptop collector does not apply that allowlist.
