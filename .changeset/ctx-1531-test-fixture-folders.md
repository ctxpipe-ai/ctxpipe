---
"@ctxpipe/aws-cdk": patch
---

Ingest: each skill uses one rule for test fixture folders (for example `artifacts`, `testdata`, and `fixtures`), so the apis skill no longer reads a test copy of an API specification as an API (CTX-1531).
