---
"@ctxpipe/aws-cdk": patch
---

Fix the two-factor setup error. A new migration adds three nullable columns to the `two_factors` table, so a user can turn on two-factor sign-in. A second migration marks the factor rows of users who did not finish the setup as unverified, so that they can set up two-factor again.
