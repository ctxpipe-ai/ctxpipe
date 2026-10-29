---
"@ctxpipe/aws-cdk": patch
---

Hydrate: the rename rewrite of a large Workspace no longer blocks the workflow worker for many seconds. Before, the step that plans the remaining writes parsed each Markdown file in one synchronous loop. In a Workspace with thousands of Markdown files, this loop stopped the worker for more than 15 s. The worker then could not extend its 30 s workflow lease, so a second execution of a hydrate or ingestion run started. The loop now gives the worker a turn after a file when 50 ms or more have passed since the last turn.
