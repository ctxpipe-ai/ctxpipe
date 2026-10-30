---
"@ctxpipe/aws-cdk": patch
---

Hydrate skips text that only looks like a URL (a template or a placeholder host) with no warning. It no longer logs "A URL reference was skipped: Invalid URL" for the same files on each run.
