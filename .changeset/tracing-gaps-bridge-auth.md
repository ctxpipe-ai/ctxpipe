---
"@ctxpipe/aws-cdk": patch
---

A key on `/mcp` that hit its rate limit now gets HTTP 429 with a `Retry-After` header, not 401. OAuth clients no longer sign in again for a rate limit. Traces now show the call id, result size, and error code of chat and ingest tool calls, the reason for each refused session or token, and the auth method of each request.
