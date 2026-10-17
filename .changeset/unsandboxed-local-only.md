---
"@ctxpipe/aws-cdk": patch
---

The backend and worker images refuse `SANDBOX_PROVIDER=unsandboxed`. An unsandboxed agent runs only in local development, and it gets only an allow-list of the backend's environment variables.
