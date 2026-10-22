---
"@ctxpipe/aws-cdk": patch
---

The backend lets operators change `AUTH_SECRET` and the connector encryption key without loss of stored connector secrets. The backend reads the old keys from the new `CONNECTION_SECRETS_PREVIOUS_KEYS` variable. The `secrets:reencrypt` command encrypts the stored connector secrets and two-factor secrets of all organizations again with the current keys.
