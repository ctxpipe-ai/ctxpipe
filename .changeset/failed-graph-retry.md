---
"@ctxpipe/aws-cdk": patch
---

The worker now runs the tip check of each org with a Workspace once each hour, at a time in the hour that comes from the org id. A Workspace graph or index that failed to build (for example while the graph store was down) now builds again with no new commit: 1, 2, 4, 8 and 16 hours after it first failed, then once each 24 hours. While that retry builds the graph, the Workspace pane shows "Building graph".
