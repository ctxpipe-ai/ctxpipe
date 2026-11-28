---
"@ctxpipe/aws-cdk": patch
---

improvement: Ingest: the `instruction-areas` skill reads all practice documents in pages that fit a read budget, with no limit of 150 documents and no count limits for areas, rules, or notes. An area file keeps the rules and notes that fit, and `skipped` lists the others. A page that reaches the end of its input ends the skill as done, so a step checkpoint on the last page and an `apis` root with no found operation no longer end the step `partial`. `discover-roots` records each Go `main` package in a test fixture folder in `skipped` (CTX-1570).
