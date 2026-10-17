---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2 reads a public HTTPS git repository that has no GitHub connection, as the old ingestion did. A plain git source file under `sources/git/` links it to a Workspace, and the format upgrade adds one for each such organization repository. ctx| reads it with no credential, checks that its host has only public addresses, connects only to the addresses that it checked, follows no redirect, and reads no system or global git config. The sandbox can fetch only that repository path, and only while it prepares the source. A plain git URL must use `https://`; ssh, `git://`, and `file://` are not supported.
