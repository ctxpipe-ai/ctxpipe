---
"@ctxpipe/aws-cdk": patch
---

Before each model call, the backend removes the secrets from the text with Kingfisher. Each found secret becomes `[REDACTED:<rule id>]`. This applies to the embeddings, the LLM tiers, the OpenAI-compatible routes, Jev and the vision prompt. Images are not changed. The scrubber needs no setting. If it cannot start, the server does not start.
