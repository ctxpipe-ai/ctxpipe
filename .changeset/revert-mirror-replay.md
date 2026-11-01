---
"@ctxpipe/aws-cdk": patch
---

A connector mirror write that loses a push race goes to the semantic merge again, as before #567. The replay of #567 failed for about 45% of the writes in a burst.
