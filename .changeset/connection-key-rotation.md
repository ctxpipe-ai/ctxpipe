---
"@ctxpipe/aws-cdk": patch
---

Operators can change `AUTH_SECRET` and the connector encryption key without loss of stored connector secrets. During a roll, the backend reads the old 64-hex keys from the new `CONNECTION_SECRETS_PREVIOUS_KEYS` variable and the old `AUTH_SECRET` from the new `PREVIOUS_AUTH_SECRET` variable. The `secrets:reencrypt` command encrypts the stored connector secrets and two-factor secrets of all organizations again with the current keys. The `@ctxpipe/aws-cdk` stack has three new optional props for these values: `connectionSecretsEncryptionKey`, `connectionSecretsPreviousKeys`, and `previousAuthSecret`. Each is a plain-string Secrets Manager secret that the backend and worker tasks receive.
