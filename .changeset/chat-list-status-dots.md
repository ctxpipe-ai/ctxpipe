---
"@ctxpipe/aws-cdk": patch
---

Each chat in the Workspace chat list now shows a status dot: gray (idle), a blue spinner (working), green (finished, not opened yet), and orange (failed, stopped before it answered, or waiting for you). The chat list API adds a `lastTurn` field to each chat. There is nothing to configure and no migration.
