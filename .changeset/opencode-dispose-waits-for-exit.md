---
"@ctxpipe/aws-cdk": patch
---

When the workspace chat must force its OpenCode server to stop (SIGKILL), the stop now waits until the server has exited. Before, the stop returned while the server could still answer.
