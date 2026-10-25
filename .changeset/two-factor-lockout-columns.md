---
"@ctxpipe/aws-cdk": patch
---

Fix the two-factor setup error. A new migration adds three nullable columns to the `two_factors` table, so a user can turn on two-factor sign-in. A second migration marks the factor rows of users who did not finish the setup as unverified, so that they can set up two-factor again. The same migration turns two-factor off for users who have it on but have no stored factor. These users enabled two-factor again, and the error deleted their stored factor, so they could not sign in. After the migration, they sign in with a password and set up two-factor again. The lost factor cannot be recovered.
