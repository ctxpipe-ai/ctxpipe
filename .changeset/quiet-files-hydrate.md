---
"@ctxpipe/aws-cdk": patch
---

Fix the knowledge files that a Workspace upgrade writes: every value now parses, so hydrate no longer skips them. Workspace settings and Home list every skipped file. A skipped file of knowledge from before Workspaces shows its cause and has no "Fix using agent" button.
