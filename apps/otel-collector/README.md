# OpenTelemetry Collector (laptop)

Contributor collector for the Compose **`infra`** profile (`pnpm dev:infra`). It is **not** part of the self-host **`deploy`** profile, the AWS `CtxPipe` construct, or the product Railway project. Self-hosters set `OTEL_EXPORTER_OTLP_*` on the app services and point those at their own OTLP endpoint.

The process receives OTLP on port 4318 and prints it with the collector `debug` exporter. It starts with no tokens and no env file. **Hosted ingest** is the ClickStack collector under [`ops/observability/collector`](../../ops/observability/collector) ([ADR-038](../../.ai/memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md)). The LLM allowlist lives only in that file.

Compose mounts this `config.yaml` into `otel/opentelemetry-collector-contrib:0.149.0`. Product deploy does not publish or run a collector image.

To watch local spans, follow the container logs. App endpoints: [USING.md](../../ops/observability/USING.md#localhost-telemetry).

Hosted HyperDX and Langfuse stay opt-in on the app (`https://telemetry.ctxpipe.ai`), not through this collector.
