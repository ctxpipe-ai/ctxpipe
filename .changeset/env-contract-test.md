---
"@ctxpipe/aws-cdk": patch
---

fix: The worker keeps the knowledge plane off, and logs an error at start, when `MODEL_PROVIDER_ALLOWLIST` does not include `typesafe`, the only provider of the decision model (Jev). Before this change, such a list let each Workspace become ready, and then each plane read that needs Jev failed. A new env contract test checks that each ECS task of the construct and each service of the Compose `deploy` profile pass the start check of the backend and the plane rule, and get the settings that they need.
