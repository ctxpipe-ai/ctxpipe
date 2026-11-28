---
"@ctxpipe/aws-cdk": patch
---

fix: When Agent Vault restarts, it keeps no data, and a running ingest shard loses its vault. The shard step now destroys the sandbox of the shard. The next attempt of the step makes a new sandbox with a new vault, proxy session and CA. Before this change, each later step of the shard failed until the run ended.
