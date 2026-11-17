---
"@ctxpipe/aws-cdk": patch
---

Workspace sources and upgrades UI:

- The Linear and Slack scope editors show a load error as an error alert with Retry.
- A scope editor whose list fails shows only its error.
- The Add to Workspaces step shows each upgrade link one time.
- The Retry of a failed source list is under its message.
- An upgrade item does not repeat its status.
- A re-ingestion does not ask for a format upgrade that the Workspace already has.
- A failed re-ingestion has the title "The re-ingestion failed".
