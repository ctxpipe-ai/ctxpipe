# ctx| CLI

Universal ctx| CLI for initializing repositories and agent integrations. Install and run with **`npx ctxpipe`** (no global install required).

## Human setup

```bash
npx ctxpipe init
```

This opens an interactive wizard with repo/global setup scope selection, detected agent defaults, multi-select client setup, and a final change summary before anything is written.

If no organization is supplied, the wizard signs you in with a browser/device-code flow, loads your ctx| organizations, and lets you choose one. MCP clients still perform their own OAuth later when they first use ctx|.

**Setup credentials:** the CLI stores setup-auth tokens in the **OS keychain** when available (`@napi-rs/keyring`). If the keychain cannot be used (headless Linux, unsupported environment), it falls back to a file under `~/.config/ctxpipe/` and prints a one-time notice to stderr.

Auth helpers:

```bash
npx ctxpipe auth login
npx ctxpipe auth whoami
npx ctxpipe auth logout
```

Use **`npx ctxpipe <command> --help`** for full flags (for example `npx ctxpipe init --help` lists `--base-url`, `--scope`, `--agents`, `--dry-run`, `--json`, `--yes`, and `--no-mcp`).

## Agent and CI setup

```bash
npx ctxpipe init --org acme --agents codex,claude --scope repo --yes
npx ctxpipe mcp add --org acme --client cursor --scope user --yes
npx ctxpipe doctor --json
```

This package is in alpha while the interactive setup flow is being built.

## Contributing / repo checkout

From this monorepo, after `pnpm install` and `pnpm --filter ctxpipe build`, you can run `node packages/cli/bin/ctxpipe.js …` or `pnpm exec ctxpipe …` from the repo root if linked.
