---
"@ctxpipe/aws-cdk": patch
---

Make codesearch containment stronger. On Linux, codesearch checks an open file again before it reads the file. The TypeScript indexer never writes through a symlink. The SCIP index keeps only documents inside the checkout and outside `.git`.
