---
"@ctxpipe/aws-cdk": patch
---

A Workspace format upgrade no longer fails with "spawn git EAGAIN". ctxpipe now runs at most eight Git processes at one time, and it starts a Git process again when the server refuses it for a short time. If the server stays busy, the upgrade card names the cause and tells the user to start the upgrade again.
