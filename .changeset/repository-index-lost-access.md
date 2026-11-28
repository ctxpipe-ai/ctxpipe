---
"@ctxpipe/aws-cdk": patch
---

fix: Repository indexing: stop the hourly codesearch rebuild of a repository after GitHub refuses ctxpipe access to it. The Workspace sources list shows the repository as not indexed, with the fix. The repository indexes again when the installation gets it back, when the user refreshes the Workspace, or after one week (CTX-1297).
