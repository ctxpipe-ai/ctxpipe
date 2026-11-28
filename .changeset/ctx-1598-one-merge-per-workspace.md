---
"@ctxpipe/aws-cdk": patch
---

fix: One semantic merge of a Workspace runs at a time. Before, the queued merges of one Workspace raced on its default branch: each push made the other merges discard their merge commits and merge again. Now a merge waits for the lease of its Workspace without a worker slot, then merges once onto the newest tip. No change is lost.
