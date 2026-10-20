---
"@ctxpipe/aws-cdk": patch
---

Fix the knowledge files that a Workspace upgrade writes: every value now parses, so hydrate no longer skips them. Workspace settings and Home list a skipped file only when the default branch holds it, and show "Fix using agent" only for such a file.
