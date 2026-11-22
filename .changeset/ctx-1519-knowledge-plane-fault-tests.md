---
"@ctxpipe/aws-cdk": patch
---

The knowledge plane repairs a Workspace whose ClickHouse rows are lost. When the head of the default branch shows no tree row, the next projection run rebuilds the Workspace in full from Git. Before this change, the run answered `current` or applied only a delta, and the Workspace stayed empty. For a partial loss, an operator can start a full rebuild with `src/scripts/rebuildKnowledgePlane.ts`. With the `knowledge_plane` flag `on`, the graph pane now shows the graph when the plane is ready, also when the FalkorDB graph is still pending.
