---
"@ctxpipe/aws-cdk": patch
---

fix: The backend and worker images install libatomic, which the copied Node 26 binary needs on x86_64; the build runs `node --version`.
