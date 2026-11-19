---
"@ctxpipe/aws-cdk": patch
---

The full-text side of the knowledge search reads only the matches of the searched Workspaces, through a GIN index by org and Workspace, not every match of the org. Migrate builds the new index without blocking writes.
