---
"@ctxpipe/aws-cdk": patch
---

Fix the Linear token refresh. A Linear connection whose access token had expired failed on every call, so the source editor and Linear source syncs stopped.
