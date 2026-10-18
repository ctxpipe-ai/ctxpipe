---
"@ctxpipe/aws-cdk": patch
---

The migrate task runs the same steps and backfills as Docker Compose and the hosted deploy. When the `ctxpipe_app` role does not exist and no password is given, migrate stops with exit code 1 before it changes the database, and it tells you how to fix it.
