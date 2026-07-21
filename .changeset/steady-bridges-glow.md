---
"@ctxpipe/aws-cdk": patch
---

Mitigate Bedrock repository-ingestion stalls by using non-streaming chat models for code-ingestion agents and hardening the ingest OpenWorkflow step retry (3 attempts with backoff). Conversation/MCP UI streaming is unchanged.
