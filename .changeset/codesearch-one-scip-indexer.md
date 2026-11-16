---
"@ctxpipe/aws-cdk": patch
---

Codesearch runs one SCIP indexer process at a time. A Zoekt index can still run beside it. `scip-python` now gets the same capped Node heap as `scip-typescript`. Before, two large SCIP indexers could run together and take more than 90% of the codesearch memory.
