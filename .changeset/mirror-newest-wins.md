---
"@ctxpipe/aws-cdk": patch
---

A connector mirror write that loses a push race no longer goes to the semantic merge. It reads the new tip again, keeps only the files that are newer than the snapshots on that tip, and pushes again. A file with conflict markers on the tip gets the next snapshot of its item.
