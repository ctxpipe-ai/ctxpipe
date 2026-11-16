---
"@ctxpipe/aws-cdk": patch
---

A chat sandbox start holds the Workspace lock only until its sandbox is created, so the clone and the setup of one conversation no longer make the next conversation of the Workspace wait.
