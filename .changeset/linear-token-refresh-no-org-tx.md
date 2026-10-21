---
"@ctxpipe/aws-cdk": patch
---

Fix the Linear token refresh. A Linear connection whose access token had expired failed on every call, so the source editor and Linear source syncs stopped. The Notion and PagerDuty refresh now also call the token endpoint outside a database transaction.
