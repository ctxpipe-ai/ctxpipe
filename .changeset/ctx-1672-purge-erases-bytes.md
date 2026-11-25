---
"@ctxpipe/aws-cdk": patch
---

Knowledge plane: after a purge deletes the rows of an org or a Workspace, ClickHouse also removes the bytes of those rows from the parts, on the hot volume and on the cold volume. The purge run waits until the parts hold no row of the org or the Workspace, and logs when this is done.
