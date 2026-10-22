---
"@ctxpipe/aws-cdk": patch
---

Operators can change `AUTH_SECRET` and the connector encryption key without loss of stored connector secrets. The backend reads the old keys from the new `CONNECTION_SECRETS_PREVIOUS_KEYS` variable, and the `secrets:reencrypt` command encrypts the stored secrets and two-factor secrets again with the current keys.
