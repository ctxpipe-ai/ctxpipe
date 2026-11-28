---
"@ctxpipe/aws-cdk": patch
---

fix: The spend of an ingest run uses the gateway cost that the model proxy records for each step, not the OpenCode estimate (CTX-1522).
