# ADR-011: Backend Observability via OpenTelemetry and evlog

**Status:** Accepted | **Date:** 2026-03-12 | **Tags:** backend, observability, opentelemetry, evlog

### Context

We need observability for the backend: APM (traces), LLM observability, and structured logs. Internal use targets **ClickStack / HyperDX** (logs, traces, metrics) and **self-hosted Langfuse** (LLM spans) in Railway project `ctxpipe-observability` ([ADR-038](ADR-038-self-hosted-clickstack-langfuse.md)). Self-hosting users may choose different tools (Jaeger, Grafana, Datadog, etc.). All configuration must be via environment variables.

### Decision

1. **OpenTelemetry for traces**: Use `@opentelemetry/sdk-node` with OTLP HTTP exporter. When `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, traces (including LangChain/LangGraph spans) are exported. LangChain/LangGraph spans come from `@langfuse/langchain` `CallbackHandler` passed via `runWithLangfuseContext` and `getLangfuseHandler()`, which emits gen_ai semantic conventions. No LangSmith tracing. No LangFuse env vars—spans flow through the existing OTLPTraceExporter.

2. **evlog for logs**: Use evlog with Hono middleware. When `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set, logs drain to OTLP via `createOTLPDrain` with batching and retry. Otherwise logs go to stdout only.

3. **Single endpoint, collector fan-out**: The app sends to one configurable OTLP endpoint per signal. For multiple backends, users run an OpenTelemetry Collector and configure it to fan out. **Hosted ingest** is the ClickStack collector with a merged custom file ([`ops/observability/collector/config.yaml`](../../../ops/observability/collector/config.yaml)): the **APM** path is the built-in ClickHouse exporter (full traces); the **LLM** path is `filter/llm_only` → Langfuse. [`apps/otel-collector/config.yaml`](../../../apps/otel-collector/config.yaml) remains the laptop / contrib reference. No app-side fan-out or LangFuse-specific env in the backend.

4. **Initialization order**: `parseEnv` → `initOtel` → `initEvlog` → `createApp`. OTEL must register before any code that creates spans.

### Consequences

**Positive**

- OTEL-first; any OTLP-compatible backend works.
- Self-hosters configure via env; no code changes for different targets.
- evlog provides wide-event logging; OTLP drain enables log correlation with traces.

**Negative / trade-offs**

- Requires a collector for multi-backend setups (hosted: ClickStack ClickHouse + Langfuse allowlist).
- evlog drain adds a dependency; no new log calls yet—setup only.

### Alternatives Considered

- **SDK fan-out in app**: Multiple exporters from code. Rejected: env-driven config is simpler; collector handles auth per backend.
- **Filter traces per target**: Initially deferred in favor of “LangFuse filters on ingest.” **Superseded**: OTLP ingest still recorded infra noise; the **ClickStack custom file** (allowlist copied from `apps/otel-collector/config.yaml`) applies an **allowlist** on the LLM-bound trace pipeline only, while the APM pipeline stays full-fidelity.

### Notes

- See `apps/backend/src/observability/otel.ts`, `evlog.ts`, `langfuse.ts`, [`ops/observability/collector/config.yaml`](../../../ops/observability/collector/config.yaml) (hosted), and `apps/otel-collector/config.yaml` (laptop reference).
- Env vars: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`.
- LangFuse integration: `runWithLangfuseContext` wraps graph invocations and adds `env:<deployment>` tags; nodes call `getLangfuseHandler()` in callbacks.
- PR vs prod metric readers: [ADR-038](ADR-038-self-hosted-clickstack-langfuse.md).
