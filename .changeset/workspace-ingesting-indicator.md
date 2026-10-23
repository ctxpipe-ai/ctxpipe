---
"@ctxpipe/aws-cdk": patch
---

Show when a Workspace ingests. Its row in the sidebar shows a teal pulse with the text "Ingesting N sources". Workspace settings has an "Ingesting now" list with the stage, the progress and the time so far of each repository run and connector sync. A run that waits for an earlier run of the same repository shows that it waits. A slow hydrate of the newest commit shows as one line.
