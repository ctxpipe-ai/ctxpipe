---
"@ctxpipe/aws-cdk": patch
---

Strip characters Postgres jsonb cannot store from package extract results, so a step write is not rejected and retried.
