---
"@ctxpipe/aws-cdk": patch
---

Switch Bedrock deployments to native AWS SDK auth: remove Mantle URL wiring and `bedrock:CallWithBearerToken`; backend uses Bedrock Runtime with ECS task-role SigV4.
