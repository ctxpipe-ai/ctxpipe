---
"@ctxpipe/aws-cdk": patch
---

GitHub connections that store a copy of the deployment App's credentials get the deployment App's webhooks again. A push starts re-ingestion, and a merged connector configuration pull request starts the connector sync.
