---
"@ctxpipe/aws-cdk": patch
---

improvement: Knowledge plane: the store search reads the neighbors of its best hits in one query, at the same time as the documents of the hits. The search gives the same hits, and the neighbor step adds about 22 ms (p50) in place of about 165 ms (CTX-1683).
