---
"@ctxpipe/aws-cdk": patch
---

improvement: The secret scrubber also removes the credentials of a URL of any scheme before a model call: the user and password part of `scheme://user:password@host` becomes `[REDACTED:url-credentials]`.
