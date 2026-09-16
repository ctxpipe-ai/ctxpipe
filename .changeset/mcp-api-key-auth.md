---
"ctxpipe": minor
"@ctxpipe/aws-cdk": patch
---

Add API-key MCP auth as an OAuth alternative: `--auth api-key` writes a client-specific interpolation of `CTXPIPE_API_KEY` (never the secret) into repo or user MCP config. Raise dashboard API-key rate limits so MCP is usable.
