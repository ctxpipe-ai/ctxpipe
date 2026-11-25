---
"@ctxpipe/aws-cdk": patch
---

An ingestion shard that has no place in the worker share now waits in the OpenWorkflow queue: a worker process does not claim a shard while it runs its share of shards. The worker queue depth counts these shards, so the worker scales out, and a free place goes to the shard that waits longest.
