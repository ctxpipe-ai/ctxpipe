---
"@ctxpipe/aws-cdk": patch
---

GitHub connections that store a copy of the deployment App's credentials get the deployment App's webhooks again. Pushes start re-ingestion, and merged connector configuration pull requests start the connector sync. Attaching an installation to such a connection requires a linked GitHub account that can see it.
