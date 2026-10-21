---
"@ctxpipe/aws-cdk": patch
---

The OpenWorkflow worker no longer restarts again and again on one ingestion step. The worker keeps only a bounded part of each sandbox command output and refuses a step output over 4 MiB before it reads it. A step that stops the worker three times now fails with its cause. The worker image runs its supervisor and the worker under Node, not Bun.
