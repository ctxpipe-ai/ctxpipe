---
"@ctxpipe/aws-cdk": patch
---

A failed first deploy can roll back and be deleted cleanly. The database URL writer returned a fixed physical id on delete, so CloudFormation ended in `ROLLBACK_FAILED`. It now returns the id that CloudFormation holds. No action is needed.
