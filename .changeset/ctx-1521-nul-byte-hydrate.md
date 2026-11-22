---
"@ctxpipe/aws-cdk": patch
---

A mirrored file that holds a NUL character (for example a GitHub issue body that quotes a Git protocol error) no longer fails the hydrate of its Workspace. The hydrate removes each NUL character before it writes Postgres and the graph.
