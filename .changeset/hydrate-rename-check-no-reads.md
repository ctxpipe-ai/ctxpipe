---
"@ctxpipe/aws-cdk": patch
---

improvement: Workspace hydrate: the check for renamed files reads no file when the commit renames none. A connector commit in a Workspace with thousands of files no longer reads each file of both revisions, which took about two minutes of worker CPU for each commit (CTX-1369).
