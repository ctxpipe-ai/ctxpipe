---
"@ctxpipe/aws-cdk": patch
---

feature: Knowledge plane: the deletion of an org or a Workspace deletes its rows in ClickHouse. The delete queues the `knowledge-purge` workflow. The worker waits until the delete is done and no knowledge projection run of the org or the Workspace is running. Then it deletes the rows of each knowledge table with the writer user. An org delete turns the knowledge flag of the org off at once, and the purge also deletes the knowledge state of the org in Postgres.
