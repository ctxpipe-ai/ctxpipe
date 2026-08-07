---
"@ctxpipe/aws-cdk": patch
---

Select TypeScript SCIP only when a root `tsconfig.json` / `jsconfig.json` exists, so nested-only configs no longer schedule `scip-typescript` (and fail ingest) when the indexer always runs with cwd at checkout root.
