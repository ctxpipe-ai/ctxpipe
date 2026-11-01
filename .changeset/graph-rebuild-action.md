---
"@ctxpipe/aws-cdk": patch
---

When the graph of a Workspace fails, the graph pane shows a Try again action. It builds the graph of the active revision again from PostgreSQL, at most once in each UTC hour, and only when the other parts of the Workspace are ready. It never hydrates a new commit.
