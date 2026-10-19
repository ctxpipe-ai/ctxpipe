---
"@ctxpipe/aws-cdk": patch
---

A Workspace re-ingestion now waits while an ingestion run of one of its source repositories is active, so that its publish does not need a merge with that run. A failed upgrade now shows the step that failed, the cause in plain words, and the action that fixes it.
