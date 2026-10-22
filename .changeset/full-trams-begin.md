---
"@ctxpipe/aws-cdk": patch
---

Add optional Secrets Manager references for the current connection encryption key and previous keys. Backend and worker tasks receive both values as ECS secrets. Operators can now rotate the keys and run the re-encrypt command with the backend task definition.
