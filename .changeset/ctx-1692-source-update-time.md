---
"@ctxpipe/aws-cdk": patch
---

fix: Knowledge search: the `updatedAt` of a connector mirror file (Linear, GitHub, Notion, Slack, Plain, PagerDuty) is the time of the last change in the source, not the time of the last commit. The `updatedAfter` filter uses this time. A mirror format change that rewrites each file no longer makes each file look new.
