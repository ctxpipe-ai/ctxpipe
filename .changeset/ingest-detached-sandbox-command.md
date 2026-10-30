---
"@ctxpipe/aws-cdk": patch
---

An ingest step in a Vercel sandbox now starts each root command detached and finds its end with short requests, so a long model step does not fail when a long-held connection closes.
