---
"@ctxpipe/aws-cdk": minor
---

Add Bedrock model provider support to `CtxPipe`: `modelProvider.kind: "bedrock"` with per-tier model IDs, Mantle URL wiring, and ECS task-role IAM for `bedrock:CallWithBearerToken` (no `MODEL_PROVIDER_API_KEY` secret). Existing `{ baseUrl, apiKey, defaultModel }` openai-like props remain backward compatible.

Requires a backend release that implements Bedrock task-role bearer auth (`@aws/bedrock-token-generator`); CDK image pins ship with that backend on the next `@ctxpipe/aws-cdk` release.
