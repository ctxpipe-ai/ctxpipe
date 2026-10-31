---
"@ctxpipe/aws-cdk": patch
---

When the graph of a Workspace fails, the graph pane shows a Try again action. It builds the graph of the active revision again from PostgreSQL, at most once each hour, and it never hydrates a new commit.
