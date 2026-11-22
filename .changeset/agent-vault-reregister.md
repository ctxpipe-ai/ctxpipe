---
"@ctxpipe/aws-cdk": patch
---

The backend registers the Agent Vault owner again when a replaced Agent Vault task answers its cached login with 503 `not_initialized`, so a new Agent Vault task no longer fails each vault call until the backend restarts.
