---
"@ctxpipe/aws-cdk": patch
---

Run the codesearch ECS container as uid/gid 1000 so Git repo-cache checkouts on EFS match the access point POSIX owner and avoid dubious-ownership reindex failures.
