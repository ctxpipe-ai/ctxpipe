---
"@ctxpipe/aws-cdk": patch
---

The backend lets operators change `AUTH_SECRET` and the connector encryption key without loss of stored connector secrets. The backend reads the old keys from the new `CONNECTION_SECRETS_PREVIOUS_KEYS` variable. The `secrets:reencrypt` command encrypts the stored connector secrets and two-factor secrets of all organizations again with the current keys. The `@ctxpipe/aws-cdk` stack does not yet give `CONNECTION_SECRETS_ENCRYPTION_KEY` or `CONNECTION_SECRETS_PREVIOUS_KEYS` to its tasks, so this roll is not yet available on that stack. A follow-up ticket adds them.
