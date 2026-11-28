---
"@ctxpipe/aws-cdk": patch
---

improvement: Each model call to OpenRouter now allows only zero data retention (ZDR) endpoints with no data collection: the model tiers, the embeddings and the OpenAI-compatible proxy routes too, not only the knowledge plane. A model with no ZDR endpoint fails. The new optional setting `MODEL_PROVIDER_ALLOWLIST` (OpenRouter provider slugs, separated by commas) limits each OpenRouter call to these providers.
