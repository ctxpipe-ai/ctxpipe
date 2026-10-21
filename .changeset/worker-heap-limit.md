---
"@ctxpipe/aws-cdk": patch
---

The worker now sets its Node heap limit from the memory of its container (about 55%, up to 12 GiB), so a large ingestion no longer stops at the default 4 GB limit. The worker also writes a heap snapshot to `/tmp/heap` before an out-of-memory exit. No action is needed. To use another limit, set `--max-old-space-size` in `NODE_OPTIONS` on the worker task.
