---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: a shard child that runs twice no longer makes assemble fail with "The shard ref 0 is not at the given tip". Assemble takes each shard tip from the shard ref, when the ref holds a later commit of the run. Before each attempt, a step reads its ref back from the tip that it starts from. When the other execution pushed the step, the step takes that commit with no model run. When the other execution moved the ref, the step continues from its tip, so later steps do not end partial one after another. Publish takes the tip of the assembled ref, so it does not drop commits of the other execution.
