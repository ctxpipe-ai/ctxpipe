---
"ctxpipe": patch
---

`ctxpipe init` and `ctxpipe mcp add` now write the generic `/mcp` URL without the `?orgSlug=` query. The server ignores that query, and each tool call names its organization.
