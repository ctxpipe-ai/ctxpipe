---
"@ctxpipe/aws-cdk": patch
---

A Workspace write no longer keeps the Git pack of the Workspace in its workflow step outputs. Each write step gets the commit from the Git host. This decreases worker memory and Postgres traffic for large Workspaces. The worker logs a warning when a workflow step output is larger than 1 MiB.
