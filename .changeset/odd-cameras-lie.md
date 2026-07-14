---
"@ctxpipe/aws-cdk": patch
---

Validate Bedrock embedding model IDs in `CtxPipe` so non-Cohere values fail fast at synth/deploy instead of causing runtime ingestion failures. Also treat blank `models.embedding` as unset and keep the default `cohere.embed-v4:0`.
