---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: a shard child that runs twice no longer makes assemble fail with "The shard ref 0 is not at the given tip". Assemble takes each shard tip from the shard ref, when the ref holds a later commit of the run. A step whose push finds the ref moved by the other execution goes on from that commit, and later steps do not end partial one after another. Publish takes the tip of the assembled ref after the repository-wide skills, so it does not drop commits of the other execution.
