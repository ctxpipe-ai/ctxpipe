---
"@ctxpipe/aws-cdk": patch
---

Knowledge plane: `get_related` always reads the relations of its seeds. Before, the relevance judge could stop the traversal at the seeds, so `get_related` returned only the seeds. The judge now decides only from which found documents the traversal goes on (CTX-1455).
