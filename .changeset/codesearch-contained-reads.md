---
"@ctxpipe/aws-cdk": patch
---

Codesearch opens a file without following a symlink at its last part. On Linux, it checks the opened file again before it reads it. The TypeScript indexer never writes through a symlink. The SCIP index keeps only documents inside the checkout and outside `.git`.
