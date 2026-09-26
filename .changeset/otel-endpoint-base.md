---
"@ctxpipe/aws-cdk": minor
---

`CtxPipe` accepts an optional `otel` prop. `otel.endpoint` is one OTLP/HTTP base URL. The construct trims it once and sets `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to `${endpoint}/v1/traces`, and the same for logs and metrics, on the backend, worker, UI, and codesearch tasks. `headers` is stored in Secrets Manager as `OTEL_EXPORTER_OTLP_HEADERS` only when export is on. `resourceAttributes` becomes `OTEL_RESOURCE_ATTRIBUTES`. `OTEL_SERVICE_NAME` is set only when `endpoint` is non-blank after trim. Omit `otel`, or leave `endpoint` blank, and the tasks export nothing. The construct does not deploy a collector. Per-signal endpoints to different vendors are not supported; point `endpoint` at a collector that fans out.
