---
"@ctxpipe/aws-cdk": patch
---

fix: The secret scrubber no longer stops on a text with the line separator (U+2028) or the paragraph separator (U+2029). Before, such a text stopped the scrubber, so each model call in flight failed, and the hydrate of a Workspace with such a file failed on each retry.
