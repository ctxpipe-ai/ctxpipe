---
"@ctxpipe/aws-cdk": patch
---

Index every TypeScript project, including the root, in its own `scip-typescript` run (parents exclude nested project directories), with workspace packages linked into a temporary `node_modules`, a heap sized from the memory share, and wire-level shard merges. Partially failed TypeScript indexes report `complete_with_issues` with a short reason; repositories where TypeScript is only an incidental nested config soft-skip instead of failing. Graph queries load SCIP one document at a time, and monorepo packages gain `PART_OF` edges to their enclosing package.
