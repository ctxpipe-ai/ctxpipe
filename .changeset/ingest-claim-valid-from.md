---
"@ctxpipe/aws-cdk": patch
---

The ingest patch validator accepts a claim that keeps the `valid_from` value that hydrate set, and refuses a claim that adds or changes `valid_from`.
