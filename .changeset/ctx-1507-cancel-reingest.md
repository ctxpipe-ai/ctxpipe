---
"@ctxpipe/aws-cdk": patch
---

An org owner or admin can cancel a queued or running re-ingestion. The cancel stops the upgrade run, its repository runs and their ingestion runs, so they make no more model calls and publish nothing. The re-ingestion shows "Canceled" and can start again.
