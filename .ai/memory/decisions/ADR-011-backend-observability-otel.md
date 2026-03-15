# ADR-011: Backend Observability via OpenTelemetry and evlog

**Status:** Accepted | **Date:** 2026-03-12 | **Tags:** backend, observability, opentelemetry, evlog

### Context

We need observability for the backend: APM (traces), LLM observability, and structured logs. Internal use targets Better Stack and LangFuse. Self-hosting users may choose different tools (Jaeger, Grafana, Datadog, etc.). All configuration must be via environment variables.

### Decision

1. **OpenTelemetry for traces**: Use `@opentelemetry/sdk-node` with OTLP HTTP exporter. When `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, traces (including LangChain/LangGraph spans) are exported. LangChain/LangGraph spans come from `@langfuse/langchain` `CallbackHandler` passed via `runWithLangfuseContext` and `getLangfuseHandler()`, which emits gen_ai semantic conventions. No LangSmith tracing. No LangFuse env vars—spans flow through the existing OTLPTraceExporter.

2. **evlog for logs**: Use evlog with Hono middleware. When `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set, logs drain to OTLP via `createOTLPDrain` with batching and retry. Otherwise logs go to stdout only.

3. **Single endpoint, collector fan-out**: The app sends to one configurable OTLP endpoint per signal. For multiple backends, users run an OpenTelemetry Collector and configure it to fan out. No filtering in the app—LangFuse filters LLM spans on ingest; APM tools receive full traces.

4. **Initialization order**: `parseEnv` → `initOtel` → `initEvlog` → `createApp`. OTEL must register before any code that creates spans.

### Consequences

**Positive**

- OTEL-first; any OTLP-compatible backend works.
- Self-hosters configure via env; no code changes for different targets.
- evlog provides wide-event logging; OTLP drain enables log correlation with traces.

**Negative / trade-offs**

- Requires collector for multi-backend setups (internal: Better Stack + LangFuse).
- evlog drain adds a dependency; no new log calls yet—setup only.

### Alternatives Considered

- **SDK fan-out in app**: Multiple exporters from code. Rejected: env-driven config is simpler; collector handles auth per backend.
- **Filter traces per target**: Send LLM spans to LangFuse, all to APM. Rejected: LangFuse filters on ingest; no need for app-side filtering.

### Notes

- See `apps/backend/src/observability/otel.ts`, `evlog.ts`, and `langfuse.ts`.
- Env vars: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`.
- LangFuse integration: `runWithLangfuseContext` wraps graph invocations; nodes call `getLangfuseHandler()` in callbacks. Handler attributes (sessionId, tags) set per request.
