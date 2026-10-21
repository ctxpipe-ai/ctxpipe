---
"@ctxpipe/aws-cdk": patch
---

An ingestion run that waits for an earlier run of the same repository now goes on after 60 minutes of wall time. Before, it counted 60 checks, and a busy worker made that wait almost 3 hours. The wait steps are now named `wait-for-earlier-run`.
