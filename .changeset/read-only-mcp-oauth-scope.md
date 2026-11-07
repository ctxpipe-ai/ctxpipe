---
"@ctxpipe/aws-cdk": patch
---

MCP OAuth clients now get read access only. The OAuth metadata lists `ctxpipe:read` and no longer lists `ctxpipe:write`. The consent page has no **Also allow changes** box. An OAuth access token gets 403 `write_grant_required` on each REST route that changes a Workspace or a connector. Sign in to ctxpipe to make these changes.
