---
"@ctxpipe/aws-cdk": patch
---

Knowledge plane: the deletion of an org or a Workspace deletes its rows in ClickHouse. The delete queues the `knowledge-purge` workflow. The worker waits until no knowledge projection run of the org or the Workspace is running, then deletes the rows of each knowledge table with the writer user. An org delete also removes the knowledge flag and the knowledge state of the org in Postgres.
