---
"@ctxpipe/aws-cdk": patch
---

fix: An ingest run no longer fails when a deploy changes the ingest skill bundle while it runs. The run goes on with the new bundle, and it keeps each finished step.
