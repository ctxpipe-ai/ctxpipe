---
"@ctxpipe/aws-cdk": patch
---

When `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set, the UI server starts the OpenTelemetry SDK. It sends one span for each request, and it sends each server error, such as a failed page render, as an Error span with the exception and as an ERROR log. The UI server removes credentials, URL queries, and emails from that error text. When no endpoint is set, the SDK does not start.
