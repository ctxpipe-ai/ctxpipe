---
"@ctxpipe/aws-cdk": patch
---

A failed ingest step attempt now logs the kind of a failed fetch ("fetch failed" or "terminated") and the code of its cause, for example `UND_ERR_SOCKET`.
