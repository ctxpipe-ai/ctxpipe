---
"@ctxpipe/aws-cdk": patch
---

improvement: Hosted chat and ingest sandboxes run only on AgentCore now, so the Vercel Sandbox provider, its hosted Workspace bases, and its ingest egress proxy are removed. The backend and the worker refuse to start while a sandbox row of the Vercel provider stays; the sandbox sweep of the release before this one removes those rows. That sweep step (the Vercel sandbox retirement) and its S3 bundle path for refused commits (`RETIRED_SANDBOX_BUCKET`) are removed too.
