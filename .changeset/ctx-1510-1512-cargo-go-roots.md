---
"@ctxpipe/aws-cdk": patch
---

Ingest finds more code roots. A Cargo path dependency of a workspace member is a root, and so is each member of a nested Cargo workspace. A Go `main` package in a folder of a module (for example `cmd/<binary>`) is a root, and classify-kind makes it a Service. Folders for tests, examples, and generated code do not give these roots.
