---
"@ctxpipe/aws-cdk": patch
---

Hydrate: the rename rewrite of a large Workspace no longer blocks the workflow worker for seconds. The step that plans the remaining writes parsed each Markdown file in one synchronous loop. On a test Workspace with about 9,000 Markdown files, this loop blocked the worker for 4.6 s, and the block grows with the file count. A long block stops the 30 s workflow lease heartbeat, so a second execution of a hydrate or ingestion run can start. Now the rewrite does no work when no file was renamed, parses the previous version of a file only when that file was renamed, and gives the worker a turn every 50 ms.
