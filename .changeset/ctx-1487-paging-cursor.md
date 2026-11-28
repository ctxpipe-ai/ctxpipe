---
"@ctxpipe/aws-cdk": patch
---

improvement: The `repository`, `libraries`, and `ownership` skills of ingestion have no page count: each page moves a cursor over the finite input that the skill's own finder gives before the page, and the skill stops when the cursor reaches the end. A page whose cursor does not move forward stops the skill as partial (CTX-1487).
