---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: when the patch validator rejects a claim that matches no claim schema, the reason now names the field that fails (for example `claims.0.evidence.kind: invalid_value`), not only `claims.0: invalid_union`. For unknown keys, the reason gives the count of keys, not their names.
