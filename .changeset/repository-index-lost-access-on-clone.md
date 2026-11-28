---
"@ctxpipe/aws-cdk": patch
---

fix: Repository indexing: stop the hourly codesearch rebuild of a private repository that has no GitHub connection. Git asks for a credential, so the run records that ctxpipe has no access, and the Workspace sources list shows the fix. The rebuild tries again after one week (CTX-1717).
