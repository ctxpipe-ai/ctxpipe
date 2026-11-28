---
"@ctxpipe/aws-cdk": patch
---

improvement: Knowledge plane: `search_knowledge` gives the top 50 documents, not the documents of the top 50 chunks. Before this change, a long document with many matching chunks took many of the 50 places. The full-text part of the search now weighs each query term by how rare it is, so a common word such as "a" or "is" adds almost nothing to the score (CTX-1455).
