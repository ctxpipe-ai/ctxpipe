---
"@ctxpipe/aws-cdk": patch
---

The worker now runs the tip check of each org with a Workspace once each hour, at a time in the hour that comes from the org id. A Workspace graph or index that failed to build (for example while the graph store was down) now builds again in the next hour, with no new commit. While that retry builds the graph, the Workspace pane shows "Building graph".
