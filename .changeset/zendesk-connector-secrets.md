---
"@ctxpipe/aws-cdk": minor
---

Add the optional `zendeskClientId` and `zendeskClientSecret` fields to `connectorSecrets`. The hosted ctx| deployment uses them for its Zendesk global OAuth client. A self-hosted deployment usually leaves them empty and saves a local OAuth client in the ctx| setup; it can also set them to use one client for every connection. The stack passes both values to the backend and the worker.
