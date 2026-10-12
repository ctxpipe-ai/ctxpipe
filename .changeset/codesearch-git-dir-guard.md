---
"@ctxpipe/aws-cdk": patch
---

Keep codesearch reads and searches inside the checkout and out of `.git`. Structural search uses the codesearch ast-grep config, not a config file from the repository.
