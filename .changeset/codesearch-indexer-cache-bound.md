---
"@ctxpipe/aws-cdk": patch
---

fix: Codesearch keeps the caches of the SCIP indexers in `indexer-cache` on the data volume, beside the repository cache, and empties them above 20 GB. Each indexer run gets its own temp directory there, which codesearch removes when the run ends.
