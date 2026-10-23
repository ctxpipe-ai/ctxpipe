---
"@ctxpipe/aws-cdk": patch
---

Fix the two-factor setup error. A new migration adds three nullable columns to the `two_factors` table, so a user can turn on two-factor sign-in.
