---
"@ctxpipe/aws-cdk": patch
---

An ingestion publish no longer fails when another source of the same Workspace created the same shared instruction file after the pin. The semantic merge now keeps the sources of both versions (CTX-1471).
