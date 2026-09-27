---
"@ctxpipe/aws-cdk": minor
---

Optional `otel` prop: one OTLP/HTTP base URL; the construct sets per-signal `OTEL_EXPORTER_OTLP_*_ENDPOINT`, headers (Secrets Manager), and `OTEL_SERVICE_NAME` on the backend, worker, UI, and codesearch tasks. No collector is deployed.
