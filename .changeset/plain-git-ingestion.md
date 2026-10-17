---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2 reads a public HTTPS git repository that has no GitHub connection, as the old ingestion did. A plain git source file under `sources/git/` links it to a Workspace, and the format upgrade adds one for each such organization repository. ctx| reads it with no credential, checks that its host has only public addresses, follows no redirect, and lets the sandbox fetch only that repository path.
