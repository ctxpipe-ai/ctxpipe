---
"@ctxpipe/aws-cdk": patch
---

fix: A Workspace write whose push loses the race at the remote merges again instead of failing its step, and a failed push logs the rejected refs and their reasons.
