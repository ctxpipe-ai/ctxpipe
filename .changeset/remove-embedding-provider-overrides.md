---
"@ctxpipe/aws-cdk": minor
---

Remove separate embedding provider configuration. Embeddings now always use the same provider URL and credentials as chat (`MODEL_PROVIDER_URL` + `/embeddings`, `MODEL_PROVIDER_API_KEY`). Removed CDK props `embedding.baseUrl` and `embedding.apiKey`, and the `CtxPipeEmbeddingOverrides` type export.
