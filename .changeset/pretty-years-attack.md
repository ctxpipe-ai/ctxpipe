---
"@ctxpipe/aws-cdk": major
---

Breaking: remove `modelProvider.defaultModel`. Configure openai-like and bedrock tiers through the same required `models` prop (`models.fast` required).

Migration: replace `defaultModel: "..."` with `models: { fast: "..." }`.
