---
"@ctxpipe/aws-cdk": patch
---

improvement: Worker: each worker start queues the sandbox sweep backstop with the same hourly key as the tip check. Many worker starts in one hour now share one sweep for each org, not one sweep for each start (CTX-1305).
