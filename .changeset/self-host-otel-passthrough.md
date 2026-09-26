---
"@ctxpipe/aws-cdk": minor
---

Optional `otel` on `CtxPipe` passes `OTEL_EXPORTER_OTLP_*`, `OTEL_RESOURCE_ATTRIBUTES`, and per-service `OTEL_SERVICE_NAME` through to ECS tasks. The construct does not deploy a collector. Omit `otel` and the tasks export nothing.
