---
"@ctxpipe/aws-cdk": minor
---

Raise codesearch Fargate memory to 4/8/12 GiB on small/medium/large so ingest peaks fit. Upgrading this package and running `cdk deploy` also rolls pinned backend, worker, UI, codesearch, and migrate images: Zoekt-optional `complete_with_issues` ingest, the memory-fit error instead of `fetch failed`, and the Postgres enum migration (run automatically on deploy).
