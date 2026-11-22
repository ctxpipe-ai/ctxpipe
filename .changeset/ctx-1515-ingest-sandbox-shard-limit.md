---
"@ctxpipe/aws-cdk": patch
---

An ingest step does not start on a shard sandbox at the shard limit. It deletes that sandbox, and the step makes a new one with a new proxy session. Before, a shard that ran for more than 75 minutes kept its sandbox after its proxy session ended, and each Git fetch of a root step failed with exit code 128 (CTX-1515).
