---
"@ctxpipe/aws-cdk": patch
---

A Workspace hydrate now reads and parses only the files that changed since the last hydrate. Each knowledge unit stores a reference index, so that the hydrate can compute the links and claims of the other units without a read of their files. The write planner uses the parse and the Git read of the hydrate. A full parse stays the fallback.
