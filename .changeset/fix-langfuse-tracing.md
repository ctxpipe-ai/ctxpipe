---
"@ctxpipe/aws-cdk": patch
---

Simplify backend Langfuse tracing: attach the LangChain callback handler once at graph boundaries and remove duplicate per-node callback wiring that caused Langfuse runMap warnings.
