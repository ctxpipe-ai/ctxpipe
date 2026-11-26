---
"@ctxpipe/aws-cdk": patch
---

Knowledge plane: after a purge deletes the rows of an org or a Workspace, ClickHouse also removes the bytes of those rows from the parts, on the hot volume and on the cold volume. The purge run waits until the parts that held the rows are gone from the disk, and logs when this is done. A purge run that fails starts again the next day. The migrations give the writer user read access to the part names in `system.parts`.
