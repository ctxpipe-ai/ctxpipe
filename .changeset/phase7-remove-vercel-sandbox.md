---
"@ctxpipe/aws-cdk": patch
---

Hosted chat and ingest sandboxes run only on AgentCore now, so the Vercel Sandbox provider, its hosted Workspace bases, and its ingest egress proxy are removed. The backend and the worker refuse to start while a sandbox row of the Vercel provider stays; the retirement script of the release before this one removes those rows.
