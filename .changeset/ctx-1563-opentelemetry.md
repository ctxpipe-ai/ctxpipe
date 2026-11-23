---
"@ctxpipe/aws-cdk": patch
---

The service images take the newest OpenTelemetry JS SDK 2 releases (stable 2.12.1, experimental 0.223.2). Outgoing HTTP client spans of the backend now carry only the stable HTTP semantic-convention attributes, for example `http.request.method`, `url.full` and `http.response.status_code` (CTX-1563).
