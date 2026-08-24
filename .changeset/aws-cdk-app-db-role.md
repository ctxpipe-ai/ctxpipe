---
"@ctxpipe/aws-cdk": minor
---

Provision a `ctxpipe_app` Postgres role on `cdk deploy` and point runtime `DATABASE_URL` at it. Existing stacks keep the same `CtxPipe` props: bump `@ctxpipe/aws-cdk` and redeploy.
