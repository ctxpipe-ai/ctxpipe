---
"@ctxpipe-ai/aws-cdk": patch
---

Remove serviceImageTag as allowing consumers to configure this can cause issue as provided image tag might not be compatible with the infra deployed by ctxpipe-ai/aws-cdk
