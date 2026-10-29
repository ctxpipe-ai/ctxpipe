---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: when a publish merges with a newer Workspace revision and a merged file fails the patch validator, the publish no longer drops all ops of the run. The publish withholds only the refused files, which keep the version on the default branch, and the other files publish. The run is `partial` and its output names each withheld file and its validator rule. The `ingestion-v2.partial` log event of a publish now has the event name in `step`, the Workspace in `workspaceId`, and the fixed rule codes in `rules`.
