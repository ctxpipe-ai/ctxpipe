---
"@ctxpipe/aws-cdk": patch
---

The secret scrubber also removes the password of a URL of any scheme (`scheme://user:password@host`) before a model call. The password becomes `[REDACTED:url-credentials]`.
