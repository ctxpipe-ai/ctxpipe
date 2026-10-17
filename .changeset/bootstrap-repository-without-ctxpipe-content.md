---
"@ctxpipe/aws-cdk": patch
---

A new Workspace on a GitHub repository that has no ctx| content now starts at the current format. An example is a new repository that you made with "Add a README". Before, such a Workspace started at format 0 and refused new sources until you ran the upgrade. Bootstrap now adds one commit with its files and `.ctxpipe/workspace.yaml`, and keeps the files that are there. A repository that has `.ctxpipe/`, `sources/` or `repositories/` keeps its format and gets the upgrade as before.
