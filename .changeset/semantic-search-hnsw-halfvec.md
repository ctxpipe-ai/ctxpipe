---
"@ctxpipe/aws-cdk": patch
---

improvement: The semantic side of the knowledge search reads the HNSW index of the embeddings, now in half precision, for a large scope, instead of the distance of every chunk in scope. Migrate builds the new index without blocking writes.
