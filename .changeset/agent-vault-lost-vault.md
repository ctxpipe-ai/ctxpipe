---
"@ctxpipe/aws-cdk": patch
---

An ingest step whose Agent Vault vault was lost (Agent Vault restarted and keeps no data) destroys the shard's sandbox, and the step's next attempt makes a new sandbox with a new vault, proxy session and CA. Before, each later step of the shard failed until the run ended.
