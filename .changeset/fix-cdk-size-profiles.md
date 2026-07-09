---
"@ctxpipe/aws-cdk": patch
---

Fix size profile database instance classes so Aurora PostgreSQL and Neptune use AWS-supported combinations (t4g.medium floor for small; r6g for larger Neptune tiers).
