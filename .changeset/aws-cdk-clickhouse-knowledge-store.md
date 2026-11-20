---
"@ctxpipe/aws-cdk": minor
---

`CtxPipe` deploys ClickHouse 26.10 for the new knowledge store: one Graviton EC2 host in a private subnet, an encrypted EBS data volume that a stack delete snapshots, and a private S3 bucket for the old parts behind a cache on the volume. Only the backend, the worker and the migrate task reach it, on port 8123. The stack generates the admin, `ctxpipe_reader` and `ctxpipe_writer` passwords. Migrate gets the admin `CLICKHOUSE_URL` and makes the two users, the backend gets the reader URL, and the worker gets the writer URL. The size profiles set the instance and the volume (`small` t4g.large and 50 GiB, `medium` r7g.large and 100 GiB, `large` r7g.xlarge and 200 GiB). The first deploy of this version adds these resources and replaces nothing that holds data. The new knowledge store stays off for every organization.
