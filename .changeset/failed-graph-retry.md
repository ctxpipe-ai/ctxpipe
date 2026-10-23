---
"@ctxpipe/aws-cdk": patch
---

A Workspace graph that failed to build (for example while the graph store was down) now builds again on the next graph read, at most once each hour, with no new commit.
