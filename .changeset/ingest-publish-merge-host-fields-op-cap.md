---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: a publish no longer withholds a merged file only because an earlier run of the same source stamped it with another `source_sha`. The merge puts back the host fields of the file on the validator's base, not the pinned ones. A merge of more than 30 files now goes through the validator in steps of at most 30 files, so no file is withheld for the per-step op cap.
