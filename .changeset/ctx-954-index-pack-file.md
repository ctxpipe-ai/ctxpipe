---
"@ctxpipe/aws-cdk": patch
---

Connector mirror writes and other Workspace writes no longer fail at `acquire-revision` with `index-pack --stdin` "Command failed" when the Workspace repository is large. The worker now decodes the Git pack to a file in chunks, and Git reads that file itself. A failed Git command now shows its exit code or signal and its error output.
