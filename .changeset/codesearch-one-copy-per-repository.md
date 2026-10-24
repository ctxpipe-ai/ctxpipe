---
"@ctxpipe/aws-cdk": patch
---

Codesearch keeps one copy of each repository: one shared git clone with a worktree for each checkout. Workspace code reads use the published checkout. The hourly cleanup also deletes files that no checkout row names. The codesearch volume needs less disk, and a clone stops with a clear error when the free disk space is too low. During an update with the CDK, Workspace code reads can fail for a few minutes, until all services run the new version.
