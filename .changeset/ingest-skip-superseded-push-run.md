---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: a push run that waits for its publish turn now ends when a newer push run of the same source is active. It ends before it calls a model, with the status `skipped` and the reason `superseded`. The newer run targets the same Workspaces, and its commit includes the older one. A re-ingestion run is never replaced. Thus several pushes in a short time give fewer paid runs, and fewer runs that publish over each other.
