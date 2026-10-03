---
"@ctxpipe/aws-cdk": minor
---

Git-backed Workspaces: each Workspace keeps its knowledge in a git repository, links code repositories for search, and has Workspace chat with Files, Diff and Graph panes. Connectors write into a Workspace. Existing stacks keep the same `CtxPipe` props: bump `@ctxpipe/aws-cdk` and run `cdk deploy`.

Workspace chat runs each conversation in a Docker sandbox on a new EC2 host that `CtxPipe` always creates: a Graviton instance sized by `size` (`t4g.medium` / `t4g.large` / `t4g.xlarge` with a 30 / 50 / 100 GB Docker volume, about $28 / $54 / $107 a month in us-east-1), Docker over mutual TLS with certificates in Secrets Manager, and CloudWatch alarms for Docker disk and memory (`sandboxHostAlarms`). Optional `sandboxHost.instanceType` and `sandboxHost.dockerVolumeSizeGiB` change its size. The chat image is published with each release and pulled by the host on first use, so releases do not replace the host. The upgrade only adds resources; it waits for the host to report ready before rolling backend and worker.
