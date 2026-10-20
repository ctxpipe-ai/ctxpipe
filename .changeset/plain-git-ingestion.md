---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2 reads a git repository that has no GitHub connection and needs no credential, as the old ingestion did. A plain git source file under `sources/git/` links it to a Workspace, and the format upgrade adds one for each such organization repository. ctx| reads it with no credential, checks the addresses of its host, follows no redirect, and reads no system or global git config. The sandbox can fetch only that repository path, and only while it prepares the source. A self-hosted deployment with Docker sandboxes (`SANDBOX_PROVIDER=docker`) keeps the behavior of main: a plain git URL can use `http://`, another port, an IP address, or an internal host, and the backend reads it with no credential and no redirect, through the proxy of its environment if there is one. Hosted ctx| and each other deployment read only public `https://` URLs on the default port. In each deployment, ssh, `git://`, and `file://` are not supported.
