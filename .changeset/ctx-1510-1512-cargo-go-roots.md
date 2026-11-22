---
"@ctxpipe/aws-cdk": patch
---

Ingest finds more code roots. A Cargo path dependency of a workspace member is a root, and so is each member of a nested Cargo workspace. A Go `main` package in a folder of a module (for example `cmd/<binary>`) is a root, and classify-kind makes it a Service. Folders for tests, examples, and generated code do not give these roots.

No count limits the roots of a run. Before, discover-roots gave at most 2,000 roots, and a run with more than 400 roots planned no root. Now the size of the discover-roots result is the only limit (1 MiB). Above it, the script gives the first roots and records what it did not give.
