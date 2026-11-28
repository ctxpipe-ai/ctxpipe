---
"@ctxpipe/aws-cdk": patch
---

Update evlog from 2.14.1 to 2.36.0 in the backend, codesearch and the UI. The logs keep the same fields: the Postgres error code of a failed query stays in the log, and the redacted fields stay redacted. ctxpipe removes the `evlog` command that evlog 2.30 and later install, because ctxpipe uses only the library.
