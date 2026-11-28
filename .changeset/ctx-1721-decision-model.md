---
"@ctxpipe/aws-cdk": minor
---

The knowledge plane calls its decision model through the `decide()` activity of TanStack AI. A self-hosted install can set the decision model with `DECISION_MODEL_PROVIDER` (`openrouter`, `openai` or `gemini`), `DECISION_MODEL_NAME`, `DECISION_MODEL_URL` and `DECISION_MODEL_API_KEY`. With no decision setting, the decision model is Jev on OpenRouter, as before.

The `CtxPipe` construct has a new optional `decisionModel` prop (`provider`, `apiKey`, and optional `model` and `baseUrl`). It keeps the key in its own Secrets Manager secret and gives the decision model settings to the backend and the worker. A Bedrock install must set it, because Bedrock has no decision model.
