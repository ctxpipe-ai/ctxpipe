---
"@ctxpipe/aws-cdk": patch
---

An ingest step in a Vercel sandbox now starts each root command detached. It finds the end of the command with short requests. A long model step no longer fails when a long-held connection closes.
