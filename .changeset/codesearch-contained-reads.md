---
"@ctxpipe/aws-cdk": patch
---

Keep codesearch file access inside the repository checkout. Codesearch follows a symlink only when its real target is inside the checkout, and it answers other symlinks as a missing file. The TypeScript indexer never writes through a symlink, and the SCIP index keeps only documents inside the checkout.
