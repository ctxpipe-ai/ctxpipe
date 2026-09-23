---
"@ctxpipe/aws-cdk": patch
---

Rank graph traversal by relation type and evidence so large services no longer hide their dependencies, owners and decisions, skip facts that have ended, always show the advisor the evidence behind graph facts, create node id indexes so graph writes stop scanning every node, make re-ingest retraction and node deletion scan the graph once per batch instead of once per id, and read ADR supersession written as links in the status header (`Superseded by [ADR-24](...)`).
