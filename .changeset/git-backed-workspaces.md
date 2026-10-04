---
"@ctxpipe/aws-cdk": minor
---

Git-backed Workspaces: each Workspace keeps its knowledge in a git repository, links code repositories for search, and has Workspace chat with Files, Diff and Graph panes. Connectors write into a Workspace.

New chat sandbox host: Workspace chat runs each conversation in its own Docker container on a new EC2 host. `CtxPipe` always creates this host. It is a Graviton instance that `size` selects (`t4g.medium` / `t4g.large` / `t4g.xlarge` with a 30 / 50 / 100 GB Docker volume, about $28 / $54 / $107 a month in us-east-1). Docker runs over mutual TLS with certificates in Secrets Manager. CloudWatch alarms watch Docker disk and memory (`sandboxHostAlarms`). The optional props `sandboxHost.instanceType` (Graviton only) and `sandboxHost.dockerVolumeSizeGiB` change the host size. The host pulls the chat image `ghcr.io/ctxpipe-ai/chat-sandbox`, published with each release, on the first chat after a release, so a release does not replace the host.

Upgrade: there are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. The upgrade only adds resources and replaces nothing that holds data. It waits until the host is ready, then rolls backend and worker.
