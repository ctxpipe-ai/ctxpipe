---
"@ctxpipe/aws-cdk": patch
"ctxpipe": patch
---

Accept authenticated GET on hosted MCP so Streamable HTTP clients can open the optional SSE listener. Bound advisor/codesearch retries, keep MCP streams alive, return JSON 503s from Better Auth during database blips, and stop the CLI from treating those failures as a forced re-login.
