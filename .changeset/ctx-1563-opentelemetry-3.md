---
"@ctxpipe/aws-cdk": patch
---

The backend, worker, UI server and codesearch images move to OpenTelemetry JS SDK 3 (`@opentelemetry/api` 1.10). Outgoing HTTP client spans of the backend now carry only the stable HTTP semantic-convention attributes, for example `http.request.method`, `url.full` and `http.response.status_code` (CTX-1563).
