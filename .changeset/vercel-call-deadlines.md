---
"@ctxpipe/aws-cdk": patch
---

Hosted chat sandboxes: each Vercel call that starts a sandbox or builds the OpenCode snapshot now has a deadline. Before this fix, a command stream that stopped could hold the snapshot build, and each chat start that waited for it, with no end.
