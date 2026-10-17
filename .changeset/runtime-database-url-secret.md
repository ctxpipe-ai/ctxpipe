---
"@ctxpipe/aws-cdk": patch
---

The runtime services read `DATABASE_URL` from a new `RuntimeDatabaseUrlSecret`, which holds the `ctxpipe_app` URL. `DatabaseUrlSecret` keeps the owner URL, as in earlier releases, and the migrate task reads it. If ECS or CloudFormation rolls back to the task definitions of an earlier release, those tasks start on the owner URL and see every row. Migrate also makes the webhook directory agree with the connections on each deploy, so connections that an earlier release added or deleted during a rollback get their webhooks again.
