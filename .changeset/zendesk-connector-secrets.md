---
"@ctxpipe/aws-cdk": minor
---

Add the optional `zendeskClientId` and `zendeskClientSecret` fields to `connectorSecrets`. The hosted ctx| deployment uses them for its Zendesk global OAuth client. Self-host leaves them empty and registers a local OAuth client in the ctx| setup. The stack passes both values to the backend and the worker.
