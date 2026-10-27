---
"@ctxpipe/aws-cdk": minor
---

Add the optional `zendeskClientId` and `zendeskClientSecret` fields to `connectorSecrets`. Set them to let a self-hosted AWS deployment use one Zendesk OAuth client for every connection. Without them, an organization owner or admin saves a local OAuth client in the ctxpipe setup. The stack passes both values to the backend and the worker.
