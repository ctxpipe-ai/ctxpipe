---
"@ctxpipe/aws-cdk": patch
---

Migrate waits at most 5 s for a database lock and tries again, so a deploy no longer fails while the old services run. A failed migrate names the Postgres statement and table.
