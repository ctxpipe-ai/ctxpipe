---
"@ctxpipe/aws-cdk": patch
---

Add Workspace no longer asks for an upgrade on a repository with no ctx| content. Before, a read of the repository before the bootstrap commit showed format 0 for a short time, and the form showed "Upgrade this Workspace before you add sources". The form now waits for the bootstrap commit, which sets the current format.
