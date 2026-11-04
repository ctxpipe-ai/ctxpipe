---
"@ctxpipe/aws-cdk": patch
---

Workspace chat on hosted sandboxes: when a sandbox start passes its deadline, the backend deletes that sandbox a second time 90 seconds later. Thus a sandbox that the provider makes after the first delete does not stay with no owner.
