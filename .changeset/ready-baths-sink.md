---
"@ctxpipe/aws-cdk": patch
---

feature: Operator jobs: a ban of a user (the `banned`, `ban_reason` and `ban_expires` fields) stops each sign-in and each credential of the user. Migrate makes the `ctxpipe_console` role, which can only queue the `admin.*` jobs and read views with no secret column.
