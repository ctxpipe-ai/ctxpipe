---
"@ctxpipe/aws-cdk": patch
---

Models: with `MODEL_PROVIDER=openai-like` and a set `MODEL_PROVIDER_URL`, host calls that need structured output now send `response_format` with a JSON schema. They do not send a forced tool call. Some local servers, for example oMLX, ignore a forced `tool_choice`, and then each structured call failed. When `MODEL_PROVIDER_URL` is not set (the OpenRouter default), the forced tool call stays. A semantic merge asks the model again when it gives no structured output, as it does when the model skips the output tool.

Embeddings: the new optional `MODEL_EMBEDDING_QUERY_INSTRUCTION` sends each search query as `Instruct: <instruction>\nQuery: <query>`. Use it with an instruction-aware embedding model, for example Qwen3-Embedding. Documents are embedded without it. When the setting is not set, queries do not change.
