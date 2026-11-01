---
"@ctxpipe/aws-cdk": patch
---

Git `merge-base` and `merge-tree` answers with exit code 1 ("not an ancestor", "conflict") no longer log `git.command_failed`. Real Git failures still log.
