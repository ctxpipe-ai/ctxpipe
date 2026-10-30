---
"@ctxpipe/aws-cdk": patch
---

The ingest patch validator accepts the host field `valid_from` on a claim. It ignores the value that a step writes, and copies the value of the base claim with the same target and predicate.
