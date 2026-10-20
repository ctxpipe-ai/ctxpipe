---
"@ctxpipe/aws-cdk": minor
---

The sandbox host runs Agent Vault, which adds the credentials of chat sandboxes to their requests. Sandboxes hold no GitHub token or backend credential, and they reach the network only through the Agent Vault proxy (HTTP and HTTPS stay open). The stack generates the Agent Vault passwords in Secrets Manager and gives the owner password to the backend and the worker.
