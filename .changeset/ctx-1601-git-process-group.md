---
"@ctxpipe/aws-cdk": patch
---

fix: A Git fetch, clone or `ls-remote` that stalls on Linux now stops at its time limit: Git runs in its own process group, and a stop ends its helper processes too (CTX-1601).
