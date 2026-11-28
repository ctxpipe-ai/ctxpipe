---
"@ctxpipe/aws-cdk": patch
---

improvement: The knowledge units and chunks of the Postgres pipeline hold scrubbed text: each secret becomes `[REDACTED:<rule id>]` before the units are cut into chunks. A stored unit with a secret gets its scrubbed text at the next hydrate of its Workspace.
