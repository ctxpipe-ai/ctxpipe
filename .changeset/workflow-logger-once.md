---
"@ctxpipe/aws-cdk": patch
---

A Workspace now gets its sandbox base. Before, the base build failed with "getLogger: no logger in context", so no Workspace got a base.
