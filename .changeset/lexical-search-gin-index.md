---
"@ctxpipe/aws-cdk": patch
---

The full-text side of the knowledge search uses its GIN index again for the app role. Before, row-level security stopped Postgres from using the index, so each search read all chunks in its scope.
