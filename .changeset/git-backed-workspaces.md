---
"@ctxpipe/aws-cdk": minor
---

Git-backed Workspaces: each Workspace keeps its knowledge in a git repository. It links code repositories for search. Each Workspace has Workspace chat with Files, Diff, and Graph panes. Connectors write into a Workspace.

New chat sandbox host: Workspace chat runs each conversation in its own Docker container. The containers run on a new EC2 host. `CtxPipe` creates this host unless you set `sandboxHost: { enabled: false }`.

The host is a Graviton instance. The `size` prop selects `t4g.medium`, `t4g.large`, or `t4g.xlarge`. The Docker volume is 30, 50, or 100 GB. The cost is about $28, $54, or $107 a month in us-east-1.

Docker runs over mutual TLS. The certificates are in Secrets Manager. CloudWatch alarms watch Docker disk and memory (`sandboxHostAlarms`).

Two optional props change the host size: `sandboxHost.instanceType` (Graviton only) and `sandboxHost.dockerVolumeSizeGiB`.

The host pulls the chat image `ghcr.io/ctxpipe-ai/chat-sandbox` on the first chat after a release. Each release publishes this image. Thus a release does not replace the host.

Upgrade: there are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. The upgrade only adds resources. It replaces nothing that holds data. It waits until the host is ready, then it rolls backend and worker.
