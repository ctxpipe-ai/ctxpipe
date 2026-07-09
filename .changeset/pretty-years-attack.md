---
"@ctxpipe/aws-cdk": major
---

Breaking: remove `modelProvider.defaultModel` and separate embedding provider overrides (`embedding.baseUrl`, `embedding.apiKey`, `CtxPipeEmbeddingOverrides`). Configure openai-like and bedrock tiers through the required `models` prop (`models.fast` required).

Migration:

- Replace `defaultModel: "..."` with `models: { fast: "..." }`.
- Remove `embedding.baseUrl` / `embedding.apiKey` — embeddings use the same provider URL and credentials as chat.

Add Amazon Bedrock model provider support: `modelProvider.kind: "bedrock"` with per-tier model IDs and ECS task-role IAM (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`). The backend calls Bedrock Runtime natively with SigV4 credentials from the task role; no `MODEL_PROVIDER_API_KEY` secret is created.
