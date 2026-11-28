---
"@ctxpipe/aws-cdk": patch
---

improvement: `get_related` on the knowledge plane gives no position and no status. It shows the claims between the top results: each stored relation with its predicate, source, `validFrom`, `validTo` and confidence, and each reading of the model with its confidence. Each result shows its source type (CTX-1720).
