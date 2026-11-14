---
"@ctxpipe/aws-cdk": patch
---

The backend writes model call spans as plain OpenTelemetry spans with the GenAI keys and has no Langfuse dependency (merge after the AWS cutover).
