# ctxpipe CLI

Universal ctx| CLI for initializing repositories and agent integrations.

## Human setup

```bash
npx ctxpipe init
```

## Agent and CI setup

```bash
npx ctxpipe init --org acme --agents codex,claude --scope repo --yes
npx ctxpipe mcp add --org acme --client cursor --scope user --yes
npx ctxpipe doctor --json
```

This package is in alpha while the interactive setup flow is being built.
