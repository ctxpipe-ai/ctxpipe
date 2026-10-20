---
"@ctxpipe/aws-cdk": patch
---

The migrate task now waits 5 seconds for a database lock, and it tries again up to 10 times when the wait times out. Before, one long transaction of a running service made migrate fail after 30 seconds. A failed migrate now prints the Postgres error code, the table, and the statement.
