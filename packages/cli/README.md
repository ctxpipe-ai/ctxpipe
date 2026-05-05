# ctxpipe CLI

Universal ctx| CLI for initializing repositories and agent integrations.

## Human setup

```bash
npx ctxpipe init
```

This opens an interactive wizard with repo/global setup scope selection, detected agent defaults, multi-select client setup, and a final change summary before anything is written.

If no organization is supplied, the wizard signs you in with a browser/device-code flow, loads your ctx| organizations, and lets you choose one. MCP clients still perform their own OAuth later when they first use ctx|.

Auth helpers:

```bash
npx ctxpipe auth login
npx ctxpipe auth whoami
npx ctxpipe auth logout
```

## Agent and CI setup

```bash
npx ctxpipe init --org acme --agents codex,claude --scope repo --yes
npx ctxpipe mcp add --org acme --client cursor --scope user --yes
npx ctxpipe doctor --json
```

This package is in alpha while the interactive setup flow is being built.
