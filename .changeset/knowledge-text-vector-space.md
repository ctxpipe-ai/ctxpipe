---
---

The knowledge plane embeds all text chunks with one text model, Qwen3 Embedding 8B, in batches of 64. Jev and the embedding calls pin no provider: OpenRouter falls back among the ZDR endpoints of the model, and the embeddings exclude the endpoints of a known low precision (fp8, int8). The search embeds the question with the instruction line of the model. An image document has no chunk and no vector. The projection version changes, so this change starts a full rebuild (CTX-1431).
