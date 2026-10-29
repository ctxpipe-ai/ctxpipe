---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: the `dependencies` skill now writes claims on a later ingest of a source. Before, the roots map listed only the files that a step of the same run wrote. A later ingest wrote no Service file, so the skill wrote no claim. The scripts now find the Service file of a root in the context index. The host runs the scan first, and starts the model only when a root has a candidate and a Service file. Each step also records counts of candidates, resolutions, and skipped choices on its span.
