---
"@ctxpipe/aws-cdk": patch
---

improvement: Knowledge from before Workspaces needs the format upgrade and the re-ingestion. The new knowledge store reads only the Workspace repository, and a later release removes the old knowledge stack that serves this knowledge from the database. The Upgrades card of each Workspace now shows the count of knowledge files that are not in the repository. When the new knowledge store serves such a Workspace, the MCP knowledge tools give a notice with the same count and action. Before you deploy the release that removes the old stack, merge the format upgrade of each Workspace, then start its re-ingestion. See "Knowledge from before Workspaces needs the re-ingestion" on the self-hosting upgrades page.
