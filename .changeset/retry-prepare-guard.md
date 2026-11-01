---
"@ctxpipe/aws-cdk": patch
---

Workspaces: "Try again" on a Workspace prepare starts a new prepare only when the prepare failed or has no tip. A retry in a different state gets 409 and changes nothing. A prepare that has no tip accepts one retry in each minute. A retry of a revision that is already published sets the Workspace ready again.
