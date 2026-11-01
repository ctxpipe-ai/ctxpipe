---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: a publish no longer withholds a merged file because an earlier run of the same source stamped the file with another `source_sha`. The merge gives each merged file the host fields of the file on its base, and the validator stamps them again. A merge of more than 30 files no longer loses files to the per-step op cap: the run's steps already counted those files, so only the Workspace cap applies.
