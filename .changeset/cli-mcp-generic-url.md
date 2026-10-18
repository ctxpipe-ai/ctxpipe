---
"ctxpipe": patch
---

`ctxpipe init` and `ctxpipe mcp add` now write the generic `/mcp` URL. They no longer add `?orgSlug=`. The server ignores that parameter. Each tool call names its organization.
