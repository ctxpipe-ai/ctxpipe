---
"@ctxpipe/aws-cdk": patch
---

The backend lets operators change `AUTH_SECRET` and the connector encryption key without loss of stored connector secrets. The backend reads the old keys from the new `CONNECTION_SECRETS_PREVIOUS_KEYS` variable (64-hex keys) and the old `AUTH_SECRET` from the new `PREVIOUS_AUTH_SECRET` variable. The `secrets:reencrypt` command encrypts the stored connector secrets and two-factor secrets of all organizations again with the current keys. The `@ctxpipe/aws-cdk` stack does not yet give these variables to its tasks, so this roll is not yet available on that stack. A follow-up ticket adds them.
