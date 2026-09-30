---
"@ctxpipe/aws-cdk": minor
---

Concurrent `ctx_advisor` calls no longer time out on database connections while Aurora is idle.

- The backend runs on a full vCPU on every size (`small` and `medium` were `256/512` and `512/1024`; now `1024/2048`). At a quarter vCPU, three parallel advisor calls throttled the task until pool checkouts and new connections passed their timeouts.
- New optional `backend` prop: `cpu`, `memoryLimitMiB`, and `desiredCount` override the size profile's backend without resizing Aurora or Neptune. If you set backend `Cpu`, `Memory`, or `DesiredCount` with a CloudFormation property override, that override still wins; remove it and use `backend` instead.
- The advisor's tool loop no longer writes a checkpoint per step (one Postgres connection per parallel tool call). The conversation graph still saves each turn.
