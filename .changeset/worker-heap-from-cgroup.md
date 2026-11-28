---
"@ctxpipe/aws-cdk": patch
---

fix: The worker reads its memory limit from its cgroup, also when the limit is on a parent cgroup, as on ECS and Fargate. Before, a Fargate worker got a Node heap limit from the host memory, above its task memory, so the platform stopped the container before Node could fail with a heap error. The worker also logs the error `openworkflow.memory-near-limit`, which names the running ingestion steps, when it nears its heap or container memory limit.
