---
"@ctxpipe/aws-cdk": patch
---

`/mcp` now explains organization problems instead of returning a bare 404: a sign-in for a different organization than the URL's `orgSlug`, or an `orgSlug` the caller cannot access, returns a JSON-RPC error that says how to fix the connection.
