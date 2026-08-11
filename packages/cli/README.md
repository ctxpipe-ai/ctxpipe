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

Use **`npx ctxpipe <command> --help`** for full flags (for example `npx ctxpipe init --help` lists `--base-url`, `--scope`, `--agents`, `--dry-run`, `--json`, `--non-interactive`, and `--no-mcp`).

## Agent and CI setup

```bash
npx ctxpipe init --org acme --agents codex,claude --scope repo --non-interactive
npx ctxpipe mcp add --org acme --client cursor --scope user --non-interactive
npx ctxpipe memory init --agents cursor --non-interactive
npx ctxpipe doctor --json
```

### Local memory (Markdown-only)

```bash
npx ctxpipe memory init
npx ctxpipe memory init --agents cursor,claude --non-interactive
```

`memory init` seeds `.ai/memory/` (indexes, lessons, decisions, sessions, PRDs, gitignored `events/`), installs the always-apply memory rule + capture skills under `.cursor/`, and wires host hooks for the selected agents (`cursor`, `claude`, …). Hooks call:

```bash
npx ctxpipe memory capture observe --host <agent> --event <type>
npx ctxpipe memory capture summary
```

Observe appends candidates under `.ai/memory/events/` (fail-open). Summary prints promotion candidates; it does **not** write durable ADRs. Agents promote via capture skills and update `index.md` files.

Interactive `memory init` can optionally store an org slug; local Markdown memory works without login. Non-interactive mode defaults `--scope` to `repo` and does not require `--org`.

Full init with memory add-on (remote MCP + Markdown memory): `npx ctxpipe init --org acme --agents cursor --memory --non-interactive`.

This package is in alpha while the interactive setup flow is being built.

## Contributing / repo checkout

From this monorepo, after `pnpm install` and `pnpm --filter ctxpipe build`, you can run `node packages/cli/bin/ctxpipe.js …` or `pnpm exec ctxpipe …` from the repo root if linked.

### Testing

```bash
pnpm --filter ctxpipe build
pnpm --filter ctxpipe test
```

CI runs `pnpm --filter ctxpipe test` on every PR ([`.github/workflows/cli-test.yaml`](../../.github/workflows/cli-test.yaml)).
