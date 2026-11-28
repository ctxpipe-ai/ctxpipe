---
"@ctxpipe/aws-cdk": patch
---

Migrate no longer leaves the migrate role a member of `ctxpipe_console`. On RDS, `ctxpipe_console` is a member of `rds_iam`, and with IAM database authentication on, RDS then refused the password of the migrate role ("PAM authentication failed"). The next migrate removes the membership that an earlier migrate left.
