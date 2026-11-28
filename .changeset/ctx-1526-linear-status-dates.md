---
"@ctxpipe/aws-cdk": patch
---

improvement: Linear: the issue mirror writes `completedAt` and `canceledAt` in the front matter. The knowledge plane links a done or canceled Linear issue to each merged GitHub pull request of its attachments from that time, as it links a closed GitHub issue from `closedAt`. Thus a time question with `validAt` finds when a Linear issue was done (CTX-1526).
