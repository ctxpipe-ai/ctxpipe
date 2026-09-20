---
"@ctxpipe/aws-cdk": patch
---

Store Linear OAuth app credentials on the connection so self-host can register the Linear app in the product UI without `LINEAR_*` env. Hosted env remains the fallback.
