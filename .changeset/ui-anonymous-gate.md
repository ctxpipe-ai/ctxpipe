---
"@ctxpipe/aws-cdk": patch
---

The UI answers a page request that has no session cookie with a redirect to sign-in, and it does not ask the backend. When the backend rate-limits the session check, the org pages also redirect to sign-in. A scanner burst no longer makes server-render errors (part of CTX-1317).
