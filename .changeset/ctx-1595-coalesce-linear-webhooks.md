---
"@ctxpipe/aws-cdk": patch
---

improvement: Linear webhooks of one connection now coalesce. A burst of Linear events gives one sources sync in each 10-minute window, not one sync for each event. Thus a burst also gives one connector mirror write and one merge for each Workspace. No event is lost: an event that comes while a sync runs goes into the next sync.
