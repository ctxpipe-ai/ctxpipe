---
"@ctxpipe/aws-cdk": patch
---

fix: The sandbox host runs Agent Vault with its pre-auth gate off (`AGENT_VAULT_RATELIMIT_AUTH_MAX` at its largest value, a 1-second window) and its rate limits locked. One sandbox that fails proxy auth no longer locks out the other sandboxes.
