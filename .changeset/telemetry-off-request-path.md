---
"@ctxpipe/aws-cdk": patch
---

Backend logs export to the OTLP collector in background batches, and the UI telemetry relay times out after 2s. A slow or unreachable collector no longer delays API responses.
