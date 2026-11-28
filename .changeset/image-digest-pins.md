---
"@ctxpipe/aws-cdk": patch
---

improvement: The service images now build from base images that are pinned to an exact tag and digest. The codesearch image builds Zoekt with Go 1.27.3, because Go 1.24 is no longer supported.
