---
"@ctxpipe/aws-cdk": patch
---

Index TypeScript monorepos per project: each outermost nested `tsconfig.json` / `jsconfig.json` gets its own `scip-typescript` run with workspace packages linked into a temporary `node_modules`, and shards merge without decoding. Monorepos whose root config lists no inputs or covers every package no longer fail with "no indexable files" or run out of heap.
