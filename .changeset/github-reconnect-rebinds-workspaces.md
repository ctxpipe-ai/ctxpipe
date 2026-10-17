---
"@ctxpipe/aws-cdk": patch
---

When you remove a GitHub connection, each Workspace that used it now shows a failed hydrate that tells you to reconnect GitHub. Before, the Workspace stayed in "pending" with no job to move it. When you connect GitHub, ctxpipe binds each GitHub Workspace that has no connection and whose repository the installation can read, and starts hydrate again. This includes Workspaces that you added by pasting a URL.
