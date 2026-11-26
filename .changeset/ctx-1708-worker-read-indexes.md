---
"@ctxpipe/aws-cdk": patch
---

Two frequent worker reads use an index: the owner run of a write job (by its id or its idempotency key), and the test that each knowledge unit has chunks (a new index of the chunks by org, Workspace and unit, which replaces the index by org). Before, each read went through all of its table (CTX-1708).
