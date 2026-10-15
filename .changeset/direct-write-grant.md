---
"@ctxpipe/aws-cdk": patch
---

API keys and read-only OAuth tokens now get 403 on routes that write directly to a Workspace. These routes need a signed-in session or an OAuth token with the `ctxpipe:write` scope.
