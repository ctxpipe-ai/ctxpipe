---
"@ctxpipe/aws-cdk": patch
"ctxpipe": patch
---

Security fixes from the npm advisories that reach the backend:

- `/mcp` refuses a request body over 4 MiB and a tool call with more than 10,000 input elements (GHSA-f897-62hf-6gxq, GHSA-46jr-4wx8-v453). The MCP SDK is now 1.32.
- zod 4.6.7 stops a validation of an oversized array from exhausting memory (GHSA-mrhx-c7xc-m3w5).
- Device login (`ctxpipe auth login`): only the ctxpipe CLI can start one, and the approval page no longer approves a code from a link by itself. The CLI now always prints the code, and the person compares it with the page and presses Approve (GHSA-q84f-53jg-9ppm).
